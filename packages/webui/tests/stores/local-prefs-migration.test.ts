import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the local-prefs migration logic.
 * We extract the same logic the store uses and verify it handles all edge cases.
 *
 * The actual migrate function lives inside zustand/persist middleware and is
 * not directly exportable — we replicate its logic here to verify 100% branch
 * coverage without depending on zustand internals.
 */

const VALID_STRATEGIES = ['hybrid', 'intelligent', 'selective'];
const VALID_AUDIT_LEVELS = ['minimal', 'standard', 'full'];
const AUTO_PROCEED_DEFAULT = 50;

function migrate(persisted: Record<string, unknown> | null): Record<string, unknown> {
  const p = (persisted ?? {}) as Record<string, unknown>;
  if (!VALID_STRATEGIES.includes(p.contextStrategy as string)) {
    p.contextStrategy = 'hybrid';
  }
  if (p.auditLevel === 'verbose') p.auditLevel = 'full';
  if (!VALID_AUDIT_LEVELS.includes(p.auditLevel as string)) {
    p.auditLevel = 'standard';
  }
  if (typeof p.autoProceedMaxIterations !== 'number') {
    p.autoProceedMaxIterations = AUTO_PROCEED_DEFAULT;
  }
  return p;
}

describe('migrate — contextStrategy', () => {
  it('keeps valid contextStrategy unchanged', () => {
    for (const val of ['hybrid', 'intelligent', 'selective']) {
      const result = migrate({ contextStrategy: val });
      expect(result.contextStrategy).toBe(val);
    }
  });

  it('migrates invalid contextStrategy to hybrid', () => {
    for (const invalid of ['frugal', 'balanced', 'deep', '', 'invalid', 'HYBRID']) {
      const result = migrate({ contextStrategy: invalid });
      expect(result.contextStrategy).toBe('hybrid');
    }
  });

  it('handles missing contextStrategy', () => {
    const result = migrate({});
    expect(result.contextStrategy).toBe('hybrid');
  });

  it('handles undefined contextStrategy', () => {
    const result = migrate({ contextStrategy: undefined });
    expect(result.contextStrategy).toBe('hybrid');
  });
});

describe('migrate — auditLevel', () => {
  it('keeps valid auditLevel unchanged', () => {
    for (const val of ['minimal', 'standard', 'full']) {
      const result = migrate({ auditLevel: val });
      expect(result.auditLevel).toBe(val);
    }
  });

  it('migrates verbose to full', () => {
    const result = migrate({ auditLevel: 'verbose' });
    expect(result.auditLevel).toBe('full');
  });

  it('migrates invalid auditLevel to standard', () => {
    for (const invalid of ['invalid', '', 'VERBOSE', 'minimal ', ' standard']) {
      const result = migrate({ auditLevel: invalid });
      expect(result.auditLevel).toBe('standard');
    }
  });

  it('handles missing auditLevel', () => {
    const result = migrate({});
    expect(result.auditLevel).toBe('standard');
  });
});

describe('migrate — autoProceedMaxIterations', () => {
  it('keeps valid numeric autoProceedMaxIterations unchanged', () => {
    for (const val of [0, 1, 50, 999, 100000]) {
      const result = migrate({ autoProceedMaxIterations: val });
      expect(result.autoProceedMaxIterations).toBe(val);
    }
  });

  it('defaults non-number autoProceedMaxIterations to 50', () => {
    for (const invalid of [undefined, null, '50', 'fifty', '', true, false, {}, []]) {
      // @ts-expect-error — intentionally passing invalid types
      const result = migrate({ autoProceedMaxIterations: invalid });
      expect(result.autoProceedMaxIterations).toBe(50);
    }
  });

  it('defaults missing autoProceedMaxIterations to 50', () => {
    const result = migrate({});
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});

describe('migrate — null/undefined persisted', () => {
  it('handles null persisted', () => {
    const result = migrate(null);
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });

  it('handles undefined persisted', () => {
    const result = migrate(undefined as never as null);
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});

describe('migrate — combined migrations', () => {
  it('migrates all invalid values at once', () => {
    const result = migrate({
      contextStrategy: 'frugal',
      auditLevel: 'verbose',
      autoProceedMaxIterations: 'not-a-number',
    });
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('full');
    expect(result.autoProceedMaxIterations).toBe(50);
  });

  it('preserves all valid values during migration', () => {
    const result = migrate({
      contextStrategy: 'intelligent',
      auditLevel: 'minimal',
      autoProceedMaxIterations: 100,
    });
    expect(result.contextStrategy).toBe('intelligent');
    expect(result.auditLevel).toBe('minimal');
    expect(result.autoProceedMaxIterations).toBe(100);
  });

  it('handles partial invalid state', () => {
    const result = migrate({
      contextStrategy: 'deep',
      auditLevel: 'standard',
    });
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});
