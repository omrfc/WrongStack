import { afterEach, describe, expect, it } from 'vitest';
import {
  configureAutophasePolicy,
  resetAutophasePolicy,
  isAutophaseCommandAllowed,
} from '../src/autophase-host.js';

describe('autophase command policy', () => {
  afterEach(() => resetAutophasePolicy());

  it('ships only the narrow package-manager base by default', () => {
    for (const cmd of ['pnpm', 'npm', 'yarn', 'bun']) {
      expect(isAutophaseCommandAllowed(cmd)).toBe(true);
    }
    // Build tools are NOT in the base — autophase runs without confirmation, so
    // it must not autonomously run arbitrary build scripts unless opted in.
    for (const cmd of ['go', 'cargo', 'make', 'dotnet']) {
      expect(isAutophaseCommandAllowed(cmd)).toBe(false);
    }
  });

  it('extends the base with the user explicit exec.allow opt-ins', () => {
    configureAutophasePolicy({ allow: ['go', 'cargo'] });
    expect(isAutophaseCommandAllowed('go')).toBe(true);
    expect(isAutophaseCommandAllowed('cargo')).toBe(true);
    expect(isAutophaseCommandAllowed('pnpm')).toBe(true); // base preserved
    expect(isAutophaseCommandAllowed('make')).toBe(false); // not opted in
  });

  it('honors deny (can remove even a base command)', () => {
    configureAutophasePolicy({ allow: ['go'], deny: ['bun'] });
    expect(isAutophaseCommandAllowed('go')).toBe(true);
    expect(isAutophaseCommandAllowed('bun')).toBe(false);
  });

  it('is rebuilt from the base each call (not cumulative)', () => {
    configureAutophasePolicy({ allow: ['go'] });
    expect(isAutophaseCommandAllowed('go')).toBe(true);
    configureAutophasePolicy({}); // no allow → go gone again
    expect(isAutophaseCommandAllowed('go')).toBe(false);
    expect(isAutophaseCommandAllowed('pnpm')).toBe(true);
  });

  it('resetAutophasePolicy restores the base', () => {
    configureAutophasePolicy({ allow: ['go'], deny: ['pnpm'] });
    resetAutophasePolicy();
    expect(isAutophaseCommandAllowed('go')).toBe(false);
    expect(isAutophaseCommandAllowed('pnpm')).toBe(true);
  });
});
