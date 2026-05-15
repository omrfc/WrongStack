import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import type { Tool } from '../../src/types/tool.js';

const t = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return '';
  },
});

describe('ToolRegistry', () => {
  it('register / get / list', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    expect(
      r
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(r.get('a')?.name).toBe('a');
  });

  it('rejects duplicate register', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(() => r.register(t('a'))).toThrow(/already/);
  });

  it('override requires existing', () => {
    const r = new ToolRegistry();
    expect(() => r.override('a', t('a'))).toThrow(/not registered/);
  });

  it('override works and tracks owner', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.override('a', t('a'), 'plug');
    expect(r.ownerOf('a')).toBe('plug');
  });

  it('registerDefault skips if already registered', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.registerDefault(t('a'), 'plug');
    expect(r.ownerOf('a')).toBe('core');
  });

  it('registerDefault registers when empty', () => {
    const r = new ToolRegistry();
    r.registerDefault(t('a'), 'core');
    expect(r.list().map((x) => x.name)).toEqual(['a']);
  });

  it('unregister', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.unregister('a')).toBe(true);
    expect(r.unregister('a')).toBe(false);
  });
});
