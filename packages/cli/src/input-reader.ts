import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { InputReader, PromptOption } from '@wrongstack/core';

export interface ReadlineInputReaderOptions {
  historyFile?: string;
  prompt?: string;
}

export class ReadlineInputReader implements InputReader {
  private rl?: readline.Interface;
  private readonly historyFile: string;
  private history: string[] = [];
  private pending = false;

  constructor(opts: ReadlineInputReaderOptions = {}) {
    this.historyFile = opts.historyFile ?? path.join(os.homedir(), '.wrongstack', 'history');
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(this.historyFile, 'utf8');
      this.history = raw.split('\n').filter(Boolean).slice(-1000);
    } catch {
      this.history = [];
    }
  }

  private async saveHistory(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      await fs.writeFile(this.historyFile, this.history.slice(-1000).join('\n'));
    } catch {
      // ignore
    }
  }

  private ensure(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        history: this.history,
        terminal: process.stdin.isTTY,
      });
    }
    return this.rl;
  }

  async readLine(prompt?: string): Promise<string> {
    if (this.history.length === 0) await this.loadHistory();
    while (this.pending) {
      // Wait for the current read to settle before accepting another.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    this.pending = true;
    try {
      const rl = this.ensure();
      if (
        (rl as unknown as { closed?: boolean }).closed ||
        (rl as unknown as { _flushed?: boolean })._flushed
      ) {
        rl.close();
        this.rl = undefined;
      }
      const fresh = this.ensure();
      return new Promise<string>((resolve) => {
        fresh.question(prompt ?? '> ', (line) => {
          if (line.trim()) {
            this.history.push(line);
            void this.saveHistory();
          }
          resolve(line);
        });
        // Ctrl+C closes the readline interface — resolve with empty
        // string so callers treat it as cancel instead of crashing with
        // an unhandled EOF error.
        fresh.once('close', () => resolve(''));
      }).then((result) => {
        // Tear down after each prompt so the next call always starts
        // fresh.  On Windows / Node ≥ 24 the interface can enter an
        // internally-closed state after question() resolves; reusing it
        // throws ERR_USE_AFTER_CLOSE.
        this.rl?.close();
        this.rl = undefined;
        return result;
      });
    } finally {
      this.pending = false;
    }
  }

  async readKey(prompt: string, options: PromptOption[]): Promise<string> {
    process.stdout.write(prompt);
    return new Promise<string>((resolve) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      const wasPaused = stdin.isPaused();
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      const onData = (buf: Buffer) => {
        const key = buf.toString();
        // Ctrl+C — treat as cancel (resolve with empty string).
        if (key === '\x03') {
          cleanup();
          process.stdout.write('\n');
          resolve('');
          return;
        }
        const opt = options.find(
          (o) => o.key.toLowerCase() === key.toLowerCase() || o.value === key,
        );
        if (opt) {
          cleanup();
          process.stdout.write(`${opt.key}\n`);
          resolve(opt.value);
        }
      };
      const onClose = () => {
        cleanup();
        resolve('');
      };
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.off('close', onClose);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        if (wasPaused) stdin.pause();
      };
      stdin.on('data', onData);
      stdin.on('close', onClose);
    });
  }

  /**
   * Read a line of input while masking each character with a bullet so the
   * user gets visual confirmation that bytes are arriving (especially on
   * paste, which previously felt like nothing happened). Pasted chunks
   * are echoed as a run of bullets, Backspace/DEL erases one bullet, and
   * Ctrl+U / Ctrl+T are honored. Non-TTY input is read normally — there's
   * nothing to hide when piped, and echoing bullets to a file is noise.
   *
   * Returns the raw entered string (no trim — caller decides).
   */
  async readSecret(prompt: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) return this.readLine(prompt);
    // Tear down the active readline so we can take over stdin.
    this.rl?.close();
    this.rl = undefined;
    process.stdout.write(prompt);
    return new Promise<string>((resolve) => {
      let buf = '';
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const eraseChar = () => {
        // Move cursor back, overwrite with space, move back again.
        process.stdout.write('\b \b');
      };
      const eraseAll = () => {
        for (let i = 0; i < buf.length; i++) eraseChar();
      };

      const onData = (chunk: string) => {
        // Process the whole chunk at once — paste arrives as one event.
        // We walk char-by-char so embedded control bytes (e.g. a stray
        // CR inside a paste) terminate input cleanly.
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            cleanup();
            process.stdout.write(`  ${dim(`[${buf.length} chars]`)}\n`);
            resolve(buf);
            return;
          }
          if (ch === '') {
            // Ctrl+C
            cleanup();
            process.stdout.write('\n');
            process.exit(130);
          }
          if (ch === '') {
            // Ctrl+U — clear line
            eraseAll();
            buf = '';
            continue;
          }
          if (ch === '') {
            // Ctrl+T — erase last whitespace-delimited token
            const m = buf.match(/(\S+\s*)$/);
            const drop = m ? m[0].length : buf.length;
            for (let i = 0; i < drop; i++) eraseChar();
            buf = buf.slice(0, buf.length - drop);
            continue;
          }
          if (ch === '' || ch === '\b') {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              eraseChar();
            }
            continue;
          }
          // Skip other control bytes silently (escape sequences, etc.).
          if (ch < ' ') continue;
          buf += ch;
          process.stdout.write('•');
        }
      };
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      };
      stdin.on('data', onData);
    });
  }

  async close(): Promise<void> {
    await this.saveHistory();
    this.rl?.close();
    this.rl = undefined;
  }
}

// Local ANSI dim — kept inline so this module has no @wrongstack/core
// dependency for its single visual flourish.
function dim(s: string): string {
  if (!process.stdout.isTTY) return s;
  return `[2m${s}[22m`;
}
