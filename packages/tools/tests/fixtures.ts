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
    hasRead(p: string) {
      return this.readFiles.has(p);
    },
    lastReadMtime(p: string) {
      return this.fileMtimes.get(p);
    },
    recordRead(p: string, m: number) {
      this.readFiles.add(p);
      this.fileMtimes.set(p, m);
    },
    todos,
    meta: {},
    session: {
      id: 'test',
      append: async () => undefined,
      close: async () => undefined,
      recordFileChange: () => {},
    },
    messages,
  (ctx as never as { state: Pick<Context['state'], 'replaceMessages' | 'replaceTodos'> }).state =
  (ctx as { state: Pick<Context['state'], 'replaceMessages' | 'replaceTodos'> }).state =
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
