import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createCustomModeStore } from '../../src/server/custom-context-modes.js';

const mockAtomicWrite = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core')>();
  return {
    ...actual,
    atomicWrite: mockAtomicWrite,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: mockReadFile,
  };
});

// Minimal mock for listContextWindowModes
vi.mock('@wrongstack/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core')>();
  return {
    ...actual,
    listContextWindowModes: () => [
      {
        id: 'balanced',
        name: 'Balanced',
        description: 'Default balanced mode',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
      },
    ],
  };
});

describe('CustomModeStore', () => {
  const testDir = '/test/.wrongstack';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('creates a new custom mode with valid data', () => {
      const store = createCustomModeStore(testDir);
      const result = store.create({
        id: 'my-mode',
        name: 'My Mode',
        description: 'A custom mode',
        thresholds: { warn: 0.5, soft: 0.7, hard: 0.85 },
        aggressiveOn: 'warn',
        preserveK: 15,
        eliseThreshold: 3000,
        targetLoad: 0.6,
        custom: false,
      });
      expect(result.ok).toBe(true);
      expect(store.list()).toContainEqual(
        expect.objectContaining({ id: 'my-mode', name: 'My Mode', custom: true }),
      );
    });

    it('rejects mode without id', () => {
      const store = createCustomModeStore(testDir);
      const result = store.create({
        id: '',
        name: 'Test',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      } as any);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('id is required');
    });

    it('rejects mode without name', () => {
      const store = createCustomModeStore(testDir);
      const result = store.create({
        id: 'test-mode',
        name: '',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('name is required');
    });

    it('rejects duplicate mode id', () => {
      const store = createCustomModeStore(testDir);
      store.create({
        id: 'my-mode',
        name: 'My Mode',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      const result = store.create({
        id: 'my-mode',
        name: 'Another Mode',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Mode "my-mode" already exists');
    });

    it('rejects overriding built-in modes', () => {
      const store = createCustomModeStore(testDir);
      const result = store.create({
        id: 'balanced',
        name: 'Not Balanced',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Cannot override built-in mode');
    });

    it('uses default values for optional fields', () => {
      const store = createCustomModeStore(testDir);
      const result = store.create({
        id: 'minimal-mode',
        name: 'Minimal',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      expect(result.ok).toBe(true);
      const mode = store.list().find((m) => m.id === 'minimal-mode');
      expect(mode?.description).toBe('');
    });
  });

  describe('update', () => {
    it('updates existing custom mode', () => {
      const store = createCustomModeStore(testDir);
      store.create({
        id: 'my-mode',
        name: 'Original',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      const result = store.update('my-mode', { name: 'Updated' });
      expect(result.ok).toBe(true);
      const mode = store.list().find((m) => m.id === 'my-mode');
      expect(mode?.name).toBe('Updated');
    });

    it('rejects updating built-in modes', () => {
      const store = createCustomModeStore(testDir);
      const result = store.update('balanced', { name: 'Hacked' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Cannot modify built-in mode');
    });

    it('rejects updating non-existent mode', () => {
      const store = createCustomModeStore(testDir);
      const result = store.update('non-existent', { name: 'Test' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Mode "non-existent" not found');
    });

    it('updates only provided fields', () => {
      const store = createCustomModeStore(testDir);
      store.create({
        id: 'my-mode',
        name: 'Original',
        description: 'Original desc',
        thresholds: { warn: 0.5, soft: 0.7, hard: 0.85 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      store.update('my-mode', { description: 'New desc' });
      const mode = store.list().find((m) => m.id === 'my-mode');
      expect(mode?.name).toBe('Original');
      expect(mode?.description).toBe('New desc');
    });
  });

  describe('remove', () => {
    it('removes existing custom mode', () => {
      const store = createCustomModeStore(testDir);
      store.create({
        id: 'my-mode',
        name: 'My Mode',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      const result = store.remove('my-mode');
      expect(result.ok).toBe(true);
      const mode = store.list().find((m) => m.id === 'my-mode');
      expect(mode).toBeUndefined();
    });

    it('rejects removing built-in modes', () => {
      const store = createCustomModeStore(testDir);
      const result = store.remove('balanced');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Cannot delete built-in mode');
    });

    it('rejects removing non-existent mode', () => {
      const store = createCustomModeStore(testDir);
      const result = store.remove('non-existent');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Mode "non-existent" not found');
    });
  });

  describe('list', () => {
    it('returns built-in modes by default', () => {
      const store = createCustomModeStore(testDir);
      const modes = store.list();
      expect(modes.some((m) => m.id === 'balanced' && m.custom === false)).toBe(true);
    });

    it('combines built-in and custom modes', () => {
      const store = createCustomModeStore(testDir);
      store.create({
        id: 'custom-mode',
        name: 'Custom',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: false,
      });
      const modes = store.list();
      expect(modes.length).toBeGreaterThan(1);
      expect(modes.some((m) => m.id === 'custom-mode')).toBe(true);
    });
  });

  describe('load', () => {
    it('loads custom modes from file', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          modes: [
            {
              id: 'loaded-mode',
              name: 'Loaded Mode',
              description: 'From file',
              thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
              aggressiveOn: 'soft',
              preserveK: 10,
              eliseThreshold: 2000,
              targetLoad: 0.65,
              custom: true,
            },
          ],
        }),
      );
      const store = createCustomModeStore(testDir);
      await store.load();
      const mode = store.list().find((m) => m.id === 'loaded-mode');
      expect(mode).toBeDefined();
      expect(mode?.name).toBe('Loaded Mode');
    });

    it('ignores corrupt JSON', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const store = createCustomModeStore(testDir);
      await store.load(); // should not throw
      expect(store.list().length).toBeGreaterThan(0);
    });
  });
});
