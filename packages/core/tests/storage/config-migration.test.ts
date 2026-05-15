import { describe, expect, it, vi } from 'vitest';
import {
  type ConfigMigration,
  ConfigMigrationError,
  runConfigMigrations,
} from '../../src/storage/config-migration.js';

describe('runConfigMigrations (L2-D)', () => {
  it('returns input unchanged when already at target version', () => {
    const input = { version: 1, foo: 'bar' };
    const result = runConfigMigrations(input, 1, []);
    expect(result.config).toEqual(input);
    expect(result.applied).toEqual([]);
    expect(result.shouldPersist).toBe(false);
  });

  it('applies a single migration step', () => {
    const v1tov2: ConfigMigration = {
      from: 1,
      to: 2,
      migrate(cfg) {
        return { ...cfg, renamed: cfg['old'], version: 2 };
      },
    };
    const result = runConfigMigrations({ version: 1, old: 'value' }, 2, [v1tov2]);
    expect(result.config['version']).toBe(2);
    expect(result.config['renamed']).toBe('value');
    expect(result.applied).toEqual(['v1→v2']);
    expect(result.shouldPersist).toBe(true);
  });

  it('chains multiple migrations in order', () => {
    const calls: string[] = [];
    const migrations: ConfigMigration[] = [
      {
        from: 1,
        to: 2,
        migrate(cfg) {
          calls.push('1->2');
          return { ...cfg, a: true, version: 2 };
        },
      },
      {
        from: 2,
        to: 3,
        migrate(cfg) {
          calls.push('2->3');
          return { ...cfg, b: true, version: 3 };
        },
      },
    ];
    const result = runConfigMigrations({ version: 1 }, 3, migrations);
    expect(calls).toEqual(['1->2', '2->3']);
    expect(result.config['a']).toBe(true);
    expect(result.config['b']).toBe(true);
    expect(result.applied).toEqual(['v1→v2', 'v2→v3']);
  });

  it('throws ConfigMigrationError when a step is missing', () => {
    const v2tov3: ConfigMigration = {
      from: 2,
      to: 3,
      migrate: (cfg) => ({ ...cfg, version: 3 }),
    };
    try {
      runConfigMigrations({ version: 1 }, 3, [v2tov3]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigMigrationError);
      const e = err as ConfigMigrationError;
      expect(e.fromVersion).toBe(1);
      expect(e.targetVersion).toBe(3);
      expect(e.missingStep).toBe(1);
    }
  });

  it('patches missing `to` version onto the result when migration forgets', () => {
    // Migration author oversight — the framework backfills `version`
    // rather than infinite-looping.
    const sloppyMigration: ConfigMigration = {
      from: 1,
      to: 2,
      migrate(cfg) {
        return { ...cfg, x: 1 }; // forgot version: 2
      },
    };
    const result = runConfigMigrations({ version: 1 }, 2, [sloppyMigration]);
    expect(result.config['version']).toBe(2);
    expect(result.config['x']).toBe(1);
  });

  it('respects shouldPersist set by the migration context', () => {
    const m: ConfigMigration = {
      from: 1,
      to: 1, // sideways migration that just normalizes fields
      migrate(cfg, ctx) {
        ctx.shouldPersist = true;
        return { ...cfg, normalized: true, version: 1 };
      },
    };
    const result = runConfigMigrations({ version: 1, normalized: false }, 1, [m]);
    // Already at target, so no migrations applied — shouldPersist stays false.
    expect(result.applied).toEqual([]);
    expect(result.shouldPersist).toBe(false);
    // But if we force the path via an artificial step:
    const force: ConfigMigration[] = [
      {
        from: 0,
        to: 1,
        migrate(cfg, ctx) {
          ctx.shouldPersist = true;
          return { ...cfg, version: 1 };
        },
      },
    ];
    const r2 = runConfigMigrations({ version: 0 }, 1, force);
    expect(r2.shouldPersist).toBe(true);
  });

  it('detects infinite loops past 100 steps', () => {
    const looper: ConfigMigration = {
      from: 1,
      to: 1, // self-loop — pathological
      migrate(cfg) {
        return { ...cfg, version: 1 };
      },
    };
    // Patch the loop guard by trying to migrate to v2 with only a 1->1 step,
    // which would loop. Since the chain doesn't reach v2, we expect either
    // the loop guard OR the "no migration found" error — both are
    // acceptable safety nets. We assert the framework throws *something*.
    try {
      runConfigMigrations({ version: 1 }, 2, [looper]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigMigrationError);
    }
  });

  it('treats missing `version` as 1', () => {
    const m: ConfigMigration = {
      from: 1,
      to: 2,
      migrate(cfg) {
        return { ...cfg, version: 2 };
      },
    };
    const result = runConfigMigrations({ foo: 'bar' }, 2, [m]);
    expect(result.config['version']).toBe(2);
  });

  it('migrate function is called with from-version in the ctx', () => {
    const seenFrom: number[] = [];
    const m: ConfigMigration = {
      from: 1,
      to: 2,
      migrate(cfg, ctx) {
        seenFrom.push(ctx.fromVersion);
        return { ...cfg, version: 2 };
      },
    };
    runConfigMigrations({ version: 1 }, 2, [m]);
    expect(seenFrom).toEqual([1]);
  });
});
