/**
 * Recommended Codex models for ChatGPT sign-in. Live backend discovery wins;
 * these values are only used when the backend/catalog cannot provide a list.
 */
export const FALLBACK_CODEX_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'gpt-5.5', name: 'gpt-5.5' },
  { id: 'gpt-5.4', name: 'gpt-5.4' },
  { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini' },
  { id: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark' },
];

/** Families in the models.dev catalog that indicate Codex / Responses API compatibility. */
export const CODEX_CATALOG_FAMILIES = new Set(['gpt-codex', 'gpt-codex-spark']);

export function fallbackCodexModelIds(): string[] {
  return FALLBACK_CODEX_MODELS.map((m) => m.id);
}

export function fallbackCodexProviderModels(): Array<{ id: string; name: string }> {
  return FALLBACK_CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }));
}

export function filterCurrentCodexModelIds(ids: Iterable<string>): string[] {
  const available = new Set(ids);
  return FALLBACK_CODEX_MODELS.map((m) => m.id).filter((id) => available.has(id));
}

export function isCodexCatalogModel(model: { family?: string | undefined }): boolean {
  return typeof model.family === 'string' && CODEX_CATALOG_FAMILIES.has(model.family);
}
