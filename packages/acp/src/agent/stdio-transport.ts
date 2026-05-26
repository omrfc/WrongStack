/**
 * StdioTransport — bidirectional stdin/stdout communication for ACP.
 *
 * ACP uses newline-delimited JSON-RPC 2.0 messages over stdio:
 *   client → agent:  JSON-RPC request/notification on stdin
 *   agent  → client: JSON-RPC response/notification on stdout
 *
 * Start message: clients look for the `[wstack-acp]` marker on stdout before
 * treating subsequent lines as protocol messages.
 */
import {ACPMessage} from '../types/acp-messages.js';

export interface AgentServerTransport {
  send(msg: ACPMessage): Promise<void>;
  sendRaw(chunk: string): void;
  read(): Promise<ACPMessage | null>;
  close(): void;
  onMessage(handler: (msg: ACPMessage) => void): () => void;
}

export class StdioTransport implements AgentServerTransport {
  private readonly stdin = process.stdin;
  private readonly stdout = process.stdout;
  private readonly stderr = process.stderr;

  private buffer = '';
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private closed = false;
  private resolveRead: ((msg: ACPMessage | null) => void) | null = null;
  private messageQueue: ACPMessage[] = [];

  constructor() {
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.onData(chunk));
    this.stdin.on('end', () => this.handleClose());
    this.stdin.on('error', (err: Error) => this.failAll(err));
  }

  sendStartupMarker(): void {
    this.stdout.write('[wstack-acp]\n', 'utf8');
  }

  send(msg: ACPMessage): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const line = JSON.stringify(msg) + '\n';
      this.stdout.write(line, 'utf8', () => resolve());
    });
  }

  sendRaw(chunk: string): void {
    this.stdout.write(chunk, 'utf8');
  }

  read(): Promise<ACPMessage | null> {
    if (this.messageQueue.length > 0) return Promise.resolve(this.messageQueue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.resolveRead = resolve;
    });
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.stdin.pause();
    this.resolveRead?.(null);
    this.resolveRead = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        this.dispatch(JSON.parse(raw) as ACPMessage);
      } catch (err) {
        this.stderr.write(`[wstack-acp parse error] ${err}\n`, 'utf8');
      }
    }
  }

  private dispatch(msg: ACPMessage): void {
    if (this.resolveRead) {
      const resolve = this.resolveRead;
      this.resolveRead = null;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        this.stderr.write(`[wstack-acp handler error] ${err}\n`, 'utf8');
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    this.resolveRead?.(null);
    this.resolveRead = null;
  }

  private failAll(err: Error): void {
    this.stderr.write(`[wstack-acp stdin error] ${err.message}\n`, 'utf8');
    this.close();
  }
}

// ---------------------------------------------------------------------------
// ClientTransport — spawns a child ACP agent process (DIR-1)
// ---------------------------------------------------------------------------

import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';

export interface ClientTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  handshakeTimeoutMs?: number;
}

export interface ACPChildProcess extends EventEmitter {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  stderr: NodeJS.ReadableStream;
  pid: number | undefined;
  kill(): void;
}

export class ClientTransport {
  private child: ACPChildProcess | null = null;
  private buffer = '';
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private closed = false;
  private resolveRead: ((msg: ACPMessage | null) => void) | null = null;
  private messageQueue: ACPMessage[] = [];
  private readonly opts: Required<Pick<ClientTransportOptions, 'handshakeTimeoutMs'>> &
    ClientTransportOptions;

  constructor(options: ClientTransportOptions) {
    this.opts = {
      handshakeTimeoutMs: 30_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.child) return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`ACP child process failed to start within ${this.opts.handshakeTimeoutMs}ms`));
      }, this.opts.handshakeTimeoutMs);

      try {
        this.child = spawn(this.opts.command, this.opts.args ?? [], {
          env: {...process.env, ...this.opts.env},
          cwd: this.opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as ACPChildProcess;
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      const child = this.child;

      child.stdout.setEncoding('utf8');

      const waitForMarker = (chunk: string) => {
        this.buffer += chunk;
        const idx = this.buffer.indexOf('[wstack-acp]\n');
        if (idx !== -1) {
          this.buffer = this.buffer.slice(idx + '[wstack-acp]\n'.length);
          child.stdout.removeListener('data', waitForMarker);
          child.stdout.on('data', (c: string) => this.onChildData(c));
          child.stderr.on('data', (c: string) => this.onChildError(c));
          child.on('close', (code: number | null) => this.onChildClose(code));
          clearTimeout(timeout);
          resolve();
        }
      };

      child.stdout.on('data', waitForMarker);
      child.stdout.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(msg: ACPMessage): Promise<void> {
    if (!this.child) return Promise.reject(new Error('ClientTransport not started'));
    return new Promise((resolve, reject) => {
      const line = JSON.stringify(msg) + '\n';
      this.child!.stdin.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  read(): Promise<ACPMessage | null> {
    if (this.messageQueue.length > 0) return Promise.resolve(this.messageQueue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.resolveRead = resolve;
    });
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stop(): void {
    if (!this.child) return;
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // already dead
    }
    this.child = null;
  }

  private onChildData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        this.dispatch(JSON.parse(raw) as ACPMessage);
      } catch {
        // skip malformed
      }
    }
  }

  private onChildError(chunk: string): void {
    process.stderr.write(`[acp-child stderr] ${chunk}`, 'utf8');
  }

  private onChildClose(code: number | null): void {
    this.closed = true;
    this.resolveRead?.(null);
    this.resolveRead = null;
    if (code !== 0 && code !== null) {
      process.stderr.write(`[acp-child exited with code ${code}]\n`, 'utf8');
    }
  }

  private dispatch(msg: ACPMessage): void {
    if (this.resolveRead) {
      const resolve = this.resolveRead;
      this.resolveRead = null;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch {
        // non-fatal
      }
    }
  }
}
