import type { WireFamily } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_BY_FAMILY,
  capabilitiesForFamily,
} from '../src/family-capabilities.js';

describe('family-capabilities', () => {
  describe('CAPABILITIES_BY_FAMILY', () => {
    it('has every known family', () => {
      const families: WireFamily[] = [
        'anthropic',
        'openai',
        'openai-compatible',
        'google',
        'unsupported',
      ];
      for (const f of families) {
        expect(CAPABILITIES_BY_FAMILY[f]).toBeDefined();
      }
    });

    it('anthropic has prompt cache and 200k context', () => {
      expect(CAPABILITIES_BY_FAMILY.anthropic.promptCache).toBe(true);
      expect(CAPABILITIES_BY_FAMILY.anthropic.maxContext).toBe(200_000);
      expect(CAPABILITIES_BY_FAMILY.anthropic.cacheControl).toBe('native');
    });

    it('openai has 128k context, json mode, no prompt cache', () => {
      expect(CAPABILITIES_BY_FAMILY.openai.maxContext).toBe(128_000);
      expect(CAPABILITIES_BY_FAMILY.openai.jsonMode).toBe(true);
      expect(CAPABILITIES_BY_FAMILY.openai.promptCache).toBe(false);
    });

    it('google reports 1M context', () => {
      expect(CAPABILITIES_BY_FAMILY.google.maxContext).toBe(1_000_000);
    });

    it('openai-compatible is the conservative default (no vision)', () => {
      expect(CAPABILITIES_BY_FAMILY['openai-compatible'].vision).toBe(false);
      expect(CAPABILITIES_BY_FAMILY['openai-compatible'].cacheControl).toBe('none');
    });

    it('unsupported disables every capability', () => {
      const u = CAPABILITIES_BY_FAMILY.unsupported;
      expect(u.tools).toBe(false);
      expect(u.parallelTools).toBe(false);
      expect(u.vision).toBe(false);
      expect(u.streaming).toBe(false);
      expect(u.promptCache).toBe(false);
      expect(u.systemPrompt).toBe(false);
      expect(u.jsonMode).toBe(false);
      expect(u.maxContext).toBe(0);
      expect(u.cacheControl).toBe('none');
    });
  });

  describe('capabilitiesForFamily', () => {
    it('returns the base capabilities when no overrides are given', () => {
      const c = capabilitiesForFamily('anthropic');
      expect(c).toEqual(CAPABILITIES_BY_FAMILY.anthropic);
    });

    it('applies overrides on top of the base', () => {
      const c = capabilitiesForFamily('openai', { maxContext: 1_000_000 });
      expect(c.maxContext).toBe(1_000_000);
      expect(c.jsonMode).toBe(true); // inherited from base
    });

    it('overrides can disable a capability', () => {
      const c = capabilitiesForFamily('anthropic', { promptCache: false });
      expect(c.promptCache).toBe(false);
      expect(c.maxContext).toBe(200_000);
    });

    it('falls back to "unsupported" for an unknown family', () => {
      const c = capabilitiesForFamily('does-not-exist' as WireFamily);
      expect(c).toEqual(CAPABILITIES_BY_FAMILY.unsupported);
    });

    it('overrides apply to the unsupported fallback too', () => {
      const c = capabilitiesForFamily('does-not-exist' as WireFamily, {
        tools: true,
        maxContext: 16_000,
      });
      expect(c.tools).toBe(true);
      expect(c.maxContext).toBe(16_000);
      expect(c.streaming).toBe(false); // inherited from unsupported
    });

    it('does not mutate the source table', () => {
      capabilitiesForFamily('anthropic', { promptCache: false });
      expect(CAPABILITIES_BY_FAMILY.anthropic.promptCache).toBe(true);
    });
  });
});
