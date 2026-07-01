/**
 * @wrongstack/plugins — catalog test
 *
 * Verifies the plugin catalog is well-formed and stays in sync with
 * the actual plugin exports.
 */
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_ENTRIES,
  PLUGIN_NAMES,
} from '../src/catalog.js';
import * as pluginExports from '../src/index.js';

describe('plugin catalog', () => {
  it('contains an entry for every plugin exported from index.ts', () => {
    // Map plugin export variable (e.g. `autoDocPlugin`) to its
    // kebab-case name. Convention: each export ends in `Plugin`.
    const exportedNames: string[] = [];
    for (const value of Object.values(pluginExports)) {
      if (
        value &&
        typeof value === 'object' &&
        'name' in value &&
        typeof (value as { name: unknown }).name === 'string'
      ) {
        exportedNames.push((value as { name: string }).name);
      }
    }
    expect(exportedNames.length).toBeGreaterThan(0);
    for (const name of exportedNames) {
      expect(PLUGIN_CATALOG.has(name), `catalog is missing ${name}`).toBe(true);
    }
  });

  it('every catalog entry has a non-empty kebab-case name and a relative path', () => {
    for (const e of PLUGIN_CATALOG_ENTRIES) {
      expect(e.name).toMatch(/^[a-z0-9-]+$/);
      expect(e.path).toMatch(/^\.\/src\/[a-z0-9-]+$/);
    }
  });

  it('PLUGIN_CATALOG has a populated map and exposes the same names as the entries', () => {
    expect(PLUGIN_CATALOG.size).toBe(PLUGIN_CATALOG_ENTRIES.length);
    expect(PLUGIN_CATALOG.size).toBeGreaterThan(0);
    for (const e of PLUGIN_CATALOG_ENTRIES) {
      expect(PLUGIN_CATALOG.get(e.name)).toBe(e.path);
    }
  });

  it('PLUGIN_CATALOG_ENTRIES is frozen and its items are frozen', () => {
    expect(Object.isFrozen(PLUGIN_CATALOG_ENTRIES)).toBe(true);
    for (const e of PLUGIN_CATALOG_ENTRIES) {
      expect(Object.isFrozen(e)).toBe(true);
    }
  });

  it('PLUGIN_NAMES has the same length as PLUGIN_CATALOG_ENTRIES', () => {
    expect(PLUGIN_NAMES.length).toBe(PLUGIN_CATALOG_ENTRIES.length);
  });

  it('PLUGIN_NAMES preserves the declared order', () => {
    const fromEntries = PLUGIN_CATALOG_ENTRIES.map((e) => e.name);
    expect([...PLUGIN_NAMES]).toEqual(fromEntries);
  });

  it('does not contain any retired plugin names', () => {
    // web-search and json-path were retired in commit e03e39d1.
    // They must NOT be in the catalog — spec-linker would otherwise
    // suggest linking to them.
    expect(PLUGIN_CATALOG.has('web-search')).toBe(false);
    expect(PLUGIN_CATALOG.has('json-path')).toBe(false);
  });
});
