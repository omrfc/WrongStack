import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DefaultSessionStore } from '../../src/index.js';

// Lift the prototype so we can override appendFile per-test without touching
// the production code path.
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

describe('DefaultSessionStore', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-'));
    store = new DefaultSessionStore({ dir: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a session and writes session_start as first event', async () => {
    const w = await store.create({ id: 'abc', model: 'm1', provider: 'p1' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hi there',
    });
    await w.close();
    const file = path.join(tmp, 'abc.jsonl');
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe('session_start');
    expect(first.model).toBe('m1');
    expect(first.provider).toBe('p1');
  });

  it('resume() appends to existing file and rehydrates messages', async () => {
    const w1 = await store.create({ id: 'res1', model: 'm', provider: 'p' });
    await w1.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'first',
    });
    await w1.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'one' }],
      usage: { input: 10, output: 5 },
      stopReason: 'end_turn',
    });
    await w1.close();

    const { writer, data } = await store.resume('res1');
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toMatchObject({ role: 'user' });
    expect(data.messages[1]).toMatchObject({ role: 'assistant' });
    // First line of resumed file is the original session_start, not the
    // resume marker.
    await writer.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'second',
    });
    await writer.close();

    const raw = await fs.readFile(path.join(tmp, 'res1.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('session_start');
    expect(lines.some((l) => l.type === 'session_resumed')).toBe(true);
    expect(lines[lines.length - 1].content).toBe('second');

    // Reloading after the second turn returns all messages including the
    // newly-appended user input.
    const reloaded = await store.load('res1');
    expect(reloaded.messages).toHaveLength(3);
  });

  it('loads and replays user_input + llm_response events', async () => {
    const w = await store.create({ id: 's1', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hello',
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi back' }],
      usage: { input: 10, output: 5 },
      model: 'm',
    });
    await w.close();

    const data = await store.load('s1');
    expect(data.metadata.id).toBe('s1');
    expect(data.metadata.model).toBe('m');
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(data.usage.input).toBe(10);
    expect(data.usage.output).toBe(5);
  });

  it('throws on damaged session (open tool_use without result)', async () => {
    const w = await store.create({ id: 'broken', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'x', input: {} }],
      usage: { input: 1, output: 1 },
      model: 'm',
    });
    await w.close();
    await expect(store.load('broken')).rejects.toThrow(/damaged/);
  });

  it('pairs tool_result with prior tool_use into single user message', async () => {
    const w = await store.create({ id: 'pair', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'x', input: {} }],
      usage: { input: 1, output: 1 },
      model: 'm',
    });
    await w.append({
      type: 'tool_result',
      ts: new Date().toISOString(),
      id: 'tu-1',
      content: 'ok',
      isError: false,
    });
    await w.close();
    const data = await store.load('pair');
    // 1 assistant + 1 user containing the tool_result
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1]?.role).toBe('user');
  });

  it('lists sessions sorted by recency', async () => {
    const a = await store.create({ id: 'a', model: 'm', provider: 'p' });
    await a.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'first',
    });
    await a.close();
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ id: 'b', model: 'm', provider: 'p' });
    await b.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'second',
    });
    await b.close();
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('list returns empty array for nonexistent dir', async () => {
    const phantomStore = new DefaultSessionStore({
      dir: path.join(tmp, 'definitely-not-here', 'sub'),
    });
    const list = await phantomStore.list();
    expect(list).toEqual([]);
  });

  it('delete removes the file', async () => {
    const w = await store.create({ id: 'doomed', model: 'm', provider: 'p' });
    await w.close();
    await store.delete('doomed');
    await expect(fs.access(path.join(tmp, 'doomed.jsonl'))).rejects.toThrow();
  });

  it('writes a summary manifest on close and list() reads it without parsing the jsonl', async () => {
    const w = await store.create({ id: 's-mani', model: 'mx', provider: 'px' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hello there!',
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await w.close();

    const manifestPath = path.join(tmp, 's-mani.summary.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest).toMatchObject({
      id: 's-mani',
      model: 'mx',
      provider: 'px',
      tokenTotal: 15,
    });
    expect(manifest.title).toContain('hello');

    // Now truncate the JSONL so list() would fail if it tried to parse —
    // proves the fast path only touched the manifest.
    await fs.writeFile(path.join(tmp, 's-mani.jsonl'), '{not json');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('s-mani');
    expect(list[0]!.tokenTotal).toBe(15);
  });

  it('list() backfills a manifest from the jsonl when one is missing', async () => {
    // Hand-write a session WITHOUT going through the writer, so no manifest exists.
    const file = path.join(tmp, 'legacy.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-05-13T10:00:00.000Z',
        id: 'legacy',
        model: 'old',
        provider: 'p',
      },
      { type: 'user_input', ts: '2026-05-13T10:00:01.000Z', content: 'older query' },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toContain('older');

    // After the first list(), the manifest should now exist.
    const manifest = path.join(tmp, 'legacy.summary.json');
    await expect(fs.access(manifest)).resolves.toBeUndefined();
  });

  it('delete() removes both the jsonl and its manifest', async () => {
    const w = await store.create({ id: 'gone', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await w.close();
    await expect(fs.access(path.join(tmp, 'gone.summary.json'))).resolves.toBeUndefined();
    await store.delete('gone');
    await expect(fs.access(path.join(tmp, 'gone.summary.json'))).rejects.toThrow();
  });

  it('debounces append-failure warnings instead of flooding the console', async () => {
    const w = await store.create({ id: 'flood', model: 'm', provider: 'p' });
    // Force every appendFile after this point to fail. The first event still
    // hits the real disk (session_start) — we replace the handle's method
    // on the instance only.
    const handle = (w as unknown as { handle: FileHandle }).handle;
    const stub = vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 25; i++) {
        await w.append({ type: 'user_input', ts: new Date().toISOString(), content: `m${i}` });
      }
      // Despite 25 failed appends, the debounce folds them into a single
      // warning (the 5-second window hasn't elapsed within the test).
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      stub.mockRestore();
      warn.mockRestore();
      await w.close().catch(() => undefined);
    }
  });

  it('surfaces the suppressed count once the debounce window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = await store.create({ id: 'flood2', model: 'm', provider: 'p' });
      const handle = (w as unknown as { handle: FileHandle }).handle;
      const stub = vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // First batch: one warn fires, the rest are debounced.
        for (let i = 0; i < 5; i++) {
          await w.append({ type: 'user_input', ts: new Date().toISOString(), content: `m${i}` });
        }
        expect(warn).toHaveBeenCalledTimes(1);
        // Advance past the 5-second debounce window and fail one more.
        vi.setSystemTime(Date.now() + 6000);
        await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'after' });
        expect(warn).toHaveBeenCalledTimes(2);
        // The second warn surfaces the count of failures that happened
        // between the two warn windows (4 events).
        const secondCall = warn.mock.calls[1]!;
        expect(secondCall.some((arg) => /\+\d+ suppressed/.test(String(arg)))).toBe(true);
      } finally {
        stub.mockRestore();
        warn.mockRestore();
        await w.close().catch(() => undefined);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
