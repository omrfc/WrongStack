import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';

export interface Sandbox {
  dir: string;
  ctx: Context;
  cleanup(): Promise<void>;
}

export async function mkSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tools-'));
  const messages: Context['messages'] = [];
  const todos: Context['todos'] = [];
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    writtenFiles: new Set<string>(),
    sideEffects: [],
    hasRead(p: string) {
      return this.readFiles.has(p);
    },
    hasWritten(p: string) {
      return (this as { writtenFiles: Set<string> }).writtenFiles.has(p);
    },
    lastReadMtime(p: string) {
      return this.fileMtimes.get(p);
    },
    recordRead(p: string, m: number, source: 'user' | 'write' = 'user') {
      this.fileMtimes.set(p, m);
      if (source === 'write') {
        (this as { writtenFiles: Set<string> }).writtenFiles.add(p);
      } else {
        this.readFiles.add(p);
      }
    },
    recordSideEffect(se: unknown) {
      (this as { sideEffects: unknown[] }).sideEffects.push(se);
    },
    clearFileTracking() {
      this.readFiles.clear();
      this.fileMtimes.clear();
      (this as { sideEffects: unknown[] }).sideEffects = [];
    },
    todos,
    meta: {},
    session: {
      id: 'test',
      append: async () => undefined,
      close: async () => undefined,
      recordFileChange: () => {},
      recordSideEffect: () => {},
    },
    messages,
  } as never as Context;
  (ctx as never as { state: Pick<Context['state'], 'replaceMessages' | 'replaceTodos'> }).state =
    {
      replaceMessages(next) {
        messages.length = 0;
        messages.splice(0, 0, ...next);
      },
      replaceTodos(next) {
        todos.length = 0;
        todos.splice(0, 0, ...next);
      },
    };
  return {
    dir,
    ctx,
    cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export function newSignal(): AbortSignal {
  return new AbortController().signal;
}
