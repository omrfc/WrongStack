import { describe, expect, it } from 'vitest';
import {
  resolveModelRuntime,
  resolveReasoningForRequest,
  resolveCacheForRequest,
} from '../../src/execution/model-runtime.js';
import type { ModelRuntimeConfig } from '../../src/types/config.js';
import type { ReasoningConfig } from '../../src/types/provider.js';

const capsOn: ReasoningConfig = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'optional',
};

const capsAlwaysOn: ReasoningConfig = {
  default: 'always_on',
  disableSupported: false,
  effortSupported: false,
  effortLevels: [],
  preserveThinking: 'always_on',
};

describe('resolveModelRuntime', () => {
  it('returns undefined fields when settings are absent', () => {
    const r = resolveModelRuntime(undefined, capsOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.cache).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('maps mode "off" to enabled:false when disableSupported', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ enabled: false });
    expect(r.warnings).toEqual([]);
  });

  it('suppresses mode "off" and warns when disable unsupported / always_on', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off' } };
    const r = resolveModelRuntime(settings, capsAlwaysOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/always on/i);
  });

  it('maps mode "on" to enabled:true', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'on' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ enabled: true });
  });

  it('maps effort only when supported and in effortLevels', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'high' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ effort: 'high' });
  });

  it('warns when effort not in supported levels', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'xhigh' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings[0]).toMatch(/not supported/);
  });

  it('maps preserve when preserveThinking !== unsupported', () => {
    const settings: ModelRuntimeConfig = { reasoning: { preserve: true } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ preserve: true });
  });

  it('maps cache ttl to Request.cache', () => {
    const settings: ModelRuntimeConfig = { cache: { ttl: '1h' } };
    const r = resolveModelRuntime(settings, undefined);
    expect(r.cache).toEqual({ ttl: '1h' });
  });

  it('is conservative when capabilities are unknown', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off' } };
    const r = resolveModelRuntime(settings, undefined);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings[0]).toMatch(/unknown/);
  });

  it('mode auto never sends explicit fields', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'auto', effort: 'high' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ effort: 'high' });
  });
});

describe('resolveReasoningForRequest (isolated)', () => {
  it('returns undefined when no reasoning config in settings', () => {
    const warnings: string[] = [];
    const r = resolveReasoningForRequest({}, capsOn, warnings);
    expect(r).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('resolveCacheForRequest (isolated)', () => {
  it('returns undefined when no cache in settings', () => {
    const r = resolveCacheForRequest({ reasoning: { mode: 'auto' } }, []);
    expect(r).toBeUndefined();
  });
});
