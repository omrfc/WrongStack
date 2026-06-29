/**
 * Local-LLM server presets for the WebUI provider selector — the
 * frontend mirror of the CLI's `LOCAL_LLM_PRESETS`
 * (`packages/cli/src/auth-menu/local-presets.ts`).
 *
 * Kept as a standalone frontend copy on purpose: the WebUI must not
 * depend on `@wrongstack/cli` (that's the top-level app — depending on
 * it would invert the package layering). This is pure UI metadata (four
 * keyless/optional-auth loopback gateways), so a small duplicated list
 * is cheaper and safer than a cross-package import. Keep in sync with
 * the CLI list and the wire-format presets in `@wrongstack/providers`.
 */

export interface LocalServerPreset {
  /** Stable id used as the saved provider id (e.g. "omniroute"). */
  id: string;
  /** Display label shown in the quick-pick row. */
  label: string;
  /** Default base URL pre-filled into the Add Provider form. */
  defaultBaseUrl: string;
  /**
   * When true, the server needs no API key (loopback gateway). Drives
   * the "no key needed" hint in the UI.
   */
  noAuth: boolean;
  /** Short hint shown under the label. */
  hint: string;
}

/** Every local-server preset is openai-compatible at the wire level. */
export const LOCAL_PRESET_FAMILY = 'openai-compatible';

export const LOCAL_SERVER_PRESETS: readonly LocalServerPreset[] = [
  {
    id: 'omniroute',
    label: 'OmniRoute',
    defaultBaseUrl: 'http://localhost:20128/v1',
    noAuth: true,
    hint: 'WrongStack local gateway · port 20128 · no key · auto-discovers models',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    noAuth: true,
    hint: 'ollama.com · port 11434 · no key',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    defaultBaseUrl: 'http://localhost:8000/v1',
    noAuth: false,
    hint: 'docs.vllm.ai · port 8000 · optional key',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseUrl: 'http://localhost:1234/v1',
    noAuth: false,
    hint: 'lmstudio.ai · port 1234 · optional key',
  },
] as const;
