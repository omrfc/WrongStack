import { describe, expect, it } from 'vitest';
import {
  LOCAL_PRESET_FAMILY,
  LOCAL_SERVER_PRESETS,
} from '../../src/components/SettingsPanel/local-presets';

/**
 * Contract tests for the WebUI's local-server presets — the frontend
 * mirror of the CLI's `LOCAL_LLM_PRESETS`. These pin the shape the
 * provider-selector quick-pick relies on (id / family / loopback URL)
 * so a typo can't silently drop a preset or point it at a remote host.
 */

describe('LOCAL_SERVER_PRESETS', () => {
  it('includes OmniRoute as the first entry on the canonical loopback port', () => {
    const first = LOCAL_SERVER_PRESETS[0];
    expect(first?.id).toBe('omniroute');
    expect(first?.defaultBaseUrl).toBe('http://localhost:20128/v1');
    expect(first?.noAuth).toBe(true);
  });

  it('offers the four CLI presets (omniroute / ollama / vllm / lmstudio)', () => {
    expect(LOCAL_SERVER_PRESETS.map((p) => p.id)).toEqual([
      'omniroute',
      'ollama',
      'vllm',
      'lmstudio',
    ]);
  });

  it('every preset is an openai-compatible loopback gateway', () => {
    expect(LOCAL_PRESET_FAMILY).toBe('openai-compatible');
    for (const preset of LOCAL_SERVER_PRESETS) {
      const url = new URL(preset.defaultBaseUrl);
      // Loopback host — never a remote API.
      expect(['localhost', '127.0.0.1']).toContain(url.hostname);
      // Path is the OpenAI-compatible /v1 base.
      expect(url.pathname).toBe('/v1');
      // Display fields are present for the quick-pick row.
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.hint.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = LOCAL_SERVER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks omniroute and ollama as keyless, vllm and lmstudio as optional-auth', () => {
    const byId = Object.fromEntries(LOCAL_SERVER_PRESETS.map((p) => [p.id, p.noAuth]));
    expect(byId['omniroute']).toBe(true);
    expect(byId['ollama']).toBe(true);
    expect(byId['vllm']).toBe(false);
    expect(byId['lmstudio']).toBe(false);
  });
});
