/**
 * StdioTransport — bidirectional stdin/stdout communication for ACP.
 *
 * ACP uses newline-delimited JSON-RPC 2.0 messages over stdio:
 *   client → agent:  JSON-RPC request/notification on stdin
 *   agent  → client: JSON-RPC response/notification on stdout
 *
 * Legacy startup marker support remains for older internal harnesses, but
 * standard ACP agents must not write non-JSON data to stdout.
 */
import { expectDefined, writeErr } from '@wrongstack/core';
import type { ACPMessage } from '../types/acp-messages.js';
import { buildWin32CmdShimInvocation } from '../win32-cmd.js';
export interface AgentServerTransport {
  send(msg: ACPMessage): Promise<void>;
  sendRaw(chunk: string): void;
  read(): Promise<ACPMessage | null>;
  close(): void;
  onMessage(handler: (msg: ACPMessage) => void): () => void;
}

/**
 * Minimal client-side transport contract `ACPSession` drives. `ClientTransport`
 * (stdio subprocess) and `WebSocketClientTransport` (remote) both implement it,
 * so the session is agnostic to how bytes reach the agent.
 */
export interface ACPClientTransport {
  start(): Promise<void>;
  send(msg: ACPMessage): Promise<void>;
  onMessage(handler: (msg: ACPMessage) => void): () => void;
  stop(): void;
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
    if (this.messageQueue.length > 0) return Promise.resolve(expectDefined(this.messageQueue.shift()));
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
    /* v8 ignore next -- split() always yields ≥1 element, so pop() is never undefined; the ?? '' is defensive. */
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

import type { EventEmitter } from 'node:events';

export interface ClientTransportOptions {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string>;
  cwd?: string | undefined;
  handshakeTimeoutMs?: number | undefined;
  /**
   * Set to true when the child is an external ACP agent (Claude Code,
   * Gemini CLI, Codex CLI, …) that does NOT emit a `[wstack-acp]\n`
   * marker on startup. The v1 client (`ACPSession`) sets this; the
   * server-side transport (the default) keeps the marker check.
   */
  skipHandshakeMarker?: boolean | undefined;
}

export interface ACPChildProcess extends EventEmitter {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  stderr: NodeJS.ReadableStream;
  pid: number | undefined;
  kill(): void;
}

export class ClientTransport implements ACPClientTransport {
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
    const [{ spawn }, { buildChildEnv }, os] = await Promise.all([
      import('node:child_process'),
      import('@wrongstack/core'),
      import('node:os'),
    ]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`ACP child process failed to start within ${this.opts.handshakeTimeoutMs}ms`),
        );
      }, this.opts.handshakeTimeoutMs);

      // `npx`/`uvx` resolve+install the package using the npm/pip config of
      // the spawn cwd. Inside a repo with dependency `overrides` (WrongStack
      // pins undici/jsdom), that install fails with EOVERRIDE and the adapter
      // never starts → handshake timeout. Spawn package launchers from a
      // NEUTRAL dir (home) so they install cleanly; the agent still learns the
      // project directory via the ACP `session/new` `cwd` param, not this cwd.
      const isPkgLauncher = this.opts.command === 'npx' || this.opts.command === 'uvx';
      const spawnCwd = isPkgLauncher ? os.homedir() : this.opts.cwd;

      try {
        const childArgs = this.opts.args ?? [];
        const shim = process.platform === 'win32'
          ? buildWin32CmdShimInvocation(this.opts.command, childArgs)
          : null;
        this.child = spawn(shim?.command ?? this.opts.command, shim?.args ?? childArgs, {
          env: { ...buildChildEnv(), ...this.opts.env },
          cwd: spawnCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
        }) as never as ACPChildProcess;
        /* v8 ignore start -- spawn() throwing synchronously is a defensive guard (e.g. argv0 type errors); the realistic async failure path is the child 'error' event, covered by tests. */
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      /* v8 ignore stop */

      const child = this.child;

      child.stdout.setEncoding('utf8');

      let settled = false;
      // Register failure handlers IMMEDIATELY, before either readiness path,
      // so a spawn failure (ENOENT / EACCES) rejects start() instead of
      // emitting an unhandled 'error' event that crashes the host process.
      // This is critical for the skip-marker path (external ACP agents),
      // which previously returned before any 'error' listener was attached.
      const onSpawnFailure = (err: Error): void => {
        if (settled) {
          // Post-ready error: just tear the connection down.
          this.closed = true;
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };
      child.on('error', onSpawnFailure);
      child.stdout.on('error', onSpawnFailure);

      if (this.opts.skipHandshakeMarker) {
        // External ACP agents don't emit a startup marker. Attach the data
        // pump right away so no early output is dropped, then resolve once
        // the OS confirms the process actually spawned (the 'spawn' event).
        // If the binary is missing, 'error' fires instead and rejects above.
        child.stdout.on('data', (c: string) => this.onChildData(c));
        child.stderr.on('data', (c: string) => this.onChildError(c));
        child.on('close', (code: number | null) => this.onChildClose(code));
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        });
        return;
      }

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        child.stdout.on('data', (c: string) => this.onChildData(c));
        child.stderr.on('data', (c: string) => this.onChildError(c));
        child.on('close', (code: number | null) => this.onChildClose(code));
        clearTimeout(timeout);
        resolve();
      };

      const waitForMarker = (chunk: string) => {
        this.buffer += chunk;
        const idx = this.buffer.indexOf('[wstack-acp]\n');
        if (idx !== -1) {
          this.buffer = this.buffer.slice(idx + '[wstack-acp]\n'.length);
          child.stdout.removeListener('data', waitForMarker);
          onReady();
        }
      };

      child.stdout.on('data', waitForMarker);
    });
  }

  send(msg: ACPMessage): Promise<void> {
    if (!this.child) return Promise.reject(new Error('ClientTransport not started'));
    return new Promise((resolve, reject) => {
      const line = JSON.stringify(msg) + '\n';
      this.child?.stdin.write(line, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  read(): Promise<ACPMessage | null> {
    if (this.messageQueue.length > 0) return Promise.resolve(expectDefined(this.messageQueue.shift()));
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
    /* v8 ignore next -- split() always yields ≥1 element, so pop() is never undefined; the ?? '' is defensive. */
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
    writeErr(`[acp-child stderr] ${chunk}`);
  }

  private onChildClose(code: number | null): void {
    this.closed = true;
    this.resolveRead?.(null);
    this.resolveRead = null;
    if (code !== 0 && code !== null) {
      writeErr(`[acp-child exited with code ${code}]\n`);
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
