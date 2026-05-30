import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultPromptStore } from '../../src/storage/prompt-store.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

function makePaths(tmpDir: string) {
  return resolveWstackPaths({ projectRoot: tmpDir, globalRoot: tmpDir });
}

describe('DefaultPromptStore', () => {
  let tmpDir: string;
  let paths: ReturnType<typeof makePaths>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-store-'));
    paths = makePaths(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── createNew ──────────────────────────────────────────────────────────────

  describe('createNew', () => {
    it('returns an entry with a short id, title, content and ISO timestamps', () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('My Prompt', 'hello world');
      expect(entry.id).toMatch(/^[a-f0-9]{8}$/);
      expect(entry.title).toBe('My Prompt');
      expect(entry.content).toBe('hello world');
      expect(entry.tags).toEqual([]);
      expect(entry.createdAt).toBe(entry.updatedAt);
      expect(new Date(entry.createdAt).toString()).not.toBe('Invalid Date');
    });

    it('accepts optional tags', () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('T', 'c', ['tag1', 'tag2']);
      expect(entry.tags).toEqual(['tag1', 'tag2']);
    });

    it('does NOT persist — list() returns empty before save()', async () => {
      const store = new DefaultPromptStore(paths);
      store.createNew('Unlisted', 'should not appear');
      await expect(store.list()).resolves.toEqual([]);
    });
  });

  // ── save ────────────────────────────────────────────────────────────────────

  describe('save', () => {
    it('writes a `${id}.json` file wrapped in { version, entry }', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Save Me', 'content here');
      await store.save(entry);

      const raw = JSON.parse(
        await fs.readFile(path.join(paths.globalPrompts, `${entry.id}.json`), 'utf8'),
      );
      expect(raw).toEqual({ version: 1, entry });
    });

    it('overwrites an existing entry for the same id', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Overwrite Me', 'v1');
      await store.save(entry);

      entry.content = 'v2';
      entry.updatedAt = new Date().toISOString();
      await store.save(entry);

      const stored = await store.get(entry.id);
      expect(stored?.content).toBe('v2');
    });

    it('creates the directory if it does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('New Dir', 'content');
      await store.save(entry);
      // Should not throw — file exists
      await expect(fs.access(path.join(paths.globalPrompts, `${entry.id}.json`))).resolves.toBeUndefined();
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when the directory does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('returns all saved entries sorted by updatedAt descending', async () => {
      const store = new DefaultPromptStore(paths);
      // Use explicit timestamps so sorting is deterministic regardless of save timing
      const a = store.createNew('A', 'a');
      a.updatedAt = new Date(1000).toISOString();
      const b = store.createNew('B', 'b');
      b.updatedAt = new Date(2000).toISOString();
      const c = store.createNew('C', 'c');
      c.updatedAt = new Date(3000).toISOString();

      await store.save(a);
      await store.save(b);
      await store.save(c);

      const listed = await store.list();
      expect(listed.map((e) => e.title)).toEqual(['C', 'B', 'A']);
    });

    it('skips non-.json files in the directory', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('With Neighbor', 'c');
      await store.save(entry);

      await fs.writeFile(path.join(paths.globalPrompts, 'README.txt'), 'not a prompt');
      await expect(store.list()).resolves.toHaveLength(1);
    });

    it('skips corrupt JSON files without throwing', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Good', 'c');
      await store.save(entry);

      await fs.writeFile(path.join(paths.globalPrompts, '01XXXXXXXX.json'), '{ broken');
      await expect(store.list()).resolves.toHaveLength(1);
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the entry when the file exists', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Get Me', 'content');
      await store.save(entry);
      await expect(store.get(entry.id)).resolves.toMatchObject({ title: 'Get Me' });
    });

    it('returns null when the id does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.get('nonexistent')).resolves.toBeNull();
    });
  });

  // ── find ────────────────────────────────────────────────────────────────────

  describe('find', () => {
    beforeEach(async () => {
      const store = new DefaultPromptStore(paths);
      await store.save(store.createNew('Deploy Script', 'run npm build && ship', ['deploy']));
      await store.save(store.createNew('Code Review', 'review PRs for bugs', ['pr']));
      await store.save(store.createNew('Readme Writer', 'write a great README', ['docs']));
    });

    it('matches by title (case-insensitive)', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('deploy')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });

    it('matches by content', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('npm build')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });

    it('matches by tag', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('docs')).resolves.toMatchObject([{ title: 'Readme Writer' }]);
    });

    it('returns all matching entries', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('e')).resolves.toHaveLength(3);
    });

    it('returns empty array when nothing matches', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('zzzzz')).resolves.toEqual([]);
    });

    it('is case-insensitive across all fields', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('DEPLOY')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the file and returns true', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('To Delete', 'bye');
      await store.save(entry);

      await expect(store.delete(entry.id)).resolves.toBe(true);
      await expect(store.get(entry.id)).resolves.toBeNull();
    });

    it('returns false when the file does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.delete('doesnotexist')).resolves.toBe(false);
    });
  });
});