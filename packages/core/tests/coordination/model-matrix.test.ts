import { describe, expect, it } from 'vitest';
import { AGENTS_BY_PHASE, AGENT_CATALOG } from '../../src/coordination/agents/index.js';
import {
  MATRIX_PHASE_KEYS,
  isValidMatrixKey,
  matrixKeyKind,
  phaseForRole,
  resolveModelMatrix,
} from '../../src/coordination/model-matrix.js';
import type { ModelMatrixEntry } from '../../src/types/config.js';

// Pick a real role + its phase from the catalog so the test stays valid as
// the catalog evolves (no hardcoded role names to drift out of sync).
const sampleRole = Object.keys(AGENT_CATALOG)[0]!;
const samplePhase = phaseForRole(sampleRole)!;

const entry = (model: string, provider?: string): ModelMatrixEntry =>
  provider ? { provider, model } : { model };

describe('resolveModelMatrix', () => {
  it('returns undefined for an absent or empty matrix', () => {
    expect(resolveModelMatrix(undefined, sampleRole)).toBeUndefined();
    expect(resolveModelMatrix({}, sampleRole)).toBeUndefined();
  });

  it('matches an exact role', () => {
    const m = { [sampleRole]: entry('minimax-m3', 'minimax') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('falls back to the role phase when no exact role entry exists', () => {
    const m = { [samplePhase]: entry('glm-5-turbo', 'zai') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ provider: 'zai', model: 'glm-5-turbo' });
  });

  it('falls back to the * default last', () => {
    const m = { '*': entry('haiku') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ model: 'haiku' });
  });

  it('honors precedence role > phase > *', () => {
    const m = {
      [sampleRole]: entry('role-model'),
      [samplePhase]: entry('phase-model'),
      '*': entry('default-model'),
    };
    expect(resolveModelMatrix(m, sampleRole)?.model).toBe('role-model');
    // remove role → phase wins
    const noRole = { [samplePhase]: entry('phase-model'), '*': entry('default-model') };
    expect(resolveModelMatrix(noRole, sampleRole)?.model).toBe('phase-model');
    // remove phase → default wins
    expect(resolveModelMatrix({ '*': entry('default-model') }, sampleRole)?.model).toBe(
      'default-model',
    );
  });

  it('uses * for an unknown role', () => {
    expect(resolveModelMatrix({ '*': entry('d') }, 'totally-unknown-role')?.model).toBe('d');
    expect(
      resolveModelMatrix({ [samplePhase]: entry('p') }, 'totally-unknown-role'),
    ).toBeUndefined();
  });
});

describe('matrixKeyKind / isValidMatrixKey', () => {
  it('classifies the default, phases, and roles', () => {
    expect(matrixKeyKind('*')).toBe('default');
    expect(matrixKeyKind(samplePhase)).toBe('phase');
    expect(matrixKeyKind(sampleRole)).toBe('role');
    expect(matrixKeyKind('nope-not-a-key')).toBe('unknown');
  });

  it('exposes every phase as a valid key', () => {
    for (const p of MATRIX_PHASE_KEYS) {
      expect(Object.keys(AGENTS_BY_PHASE)).toContain(p);
      expect(isValidMatrixKey(p)).toBe(true);
    }
    expect(isValidMatrixKey('nope')).toBe(false);
  });
});
