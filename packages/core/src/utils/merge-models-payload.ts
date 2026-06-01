import type {
  ModelsDevModel,
  ModelsDevProvider,
  ModelsDevPayload,
} from '../types/models-registry.js';

/**
 * Deep-merge a curated `overlay` payload on top of a `base` payload (both in
 * the models.dev `api.json` shape). The overlay always wins: it can add
 * providers/models the base lacks and override fields the base gets wrong.
 *
 * Precedence rules:
 *  - Provider present in both → scalar fields (`name`, `npm`, `api`, `env`,
 *    `doc`) come from the overlay when set; `models` maps merge by model id.
 *  - Provider only in the overlay → added wholesale.
 *  - Model present in both → overlay model fields override base model fields
 *    (`{ ...base, ...overlay }`), with the nested `limit` / `cost` /
 *    `modalities` objects merged one level deeper so an overlay can fix just
 *    `limit.context` without restating the rest of the model.
 *  - Model only in the overlay → added.
 *
 * Pure: never mutates its inputs.
 */
export function mergeModelsPayload(
  base: ModelsDevPayload,
  overlay: ModelsDevPayload,
): ModelsDevPayload {
  const out: ModelsDevPayload = {};
  for (const [id, provider] of Object.entries(base)) {
    out[id] = cloneProvider(provider);
  }
  for (const [id, ovProvider] of Object.entries(overlay)) {
    const existing = out[id];
    out[id] = existing ? mergeProvider(existing, ovProvider) : cloneProvider(ovProvider);
  }
  return out;
}

function mergeProvider(base: ModelsDevProvider, overlay: ModelsDevProvider): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  for (const [mid, m] of Object.entries(base.models ?? {})) {
    models[mid] = { ...m };
  }
  for (const [mid, ovModel] of Object.entries(overlay.models ?? {})) {
    const existing = models[mid];
    models[mid] = existing ? mergeModel(existing, ovModel) : { ...ovModel };
  }
  return {
    ...base,
    // Overlay scalar fields win when explicitly provided; otherwise keep base.
    ...stripUndefined({
      id: overlay.id,
      name: overlay.name,
      npm: overlay.npm,
      api: overlay.api,
      env: overlay.env,
      doc: overlay.doc,
    }),
    models,
  };
}

function mergeModel(base: ModelsDevModel, overlay: ModelsDevModel): ModelsDevModel {
  const merged: ModelsDevModel = { ...base, ...overlay };
  // One level deeper for the structured fields so a partial overlay (e.g. only
  // `limit.context`) doesn't blow away the base's other sub-fields.
  if (base.limit || overlay.limit) {
    merged.limit = { ...base.limit, ...overlay.limit };
  }
  if (base.cost || overlay.cost) {
    merged.cost = { ...base.cost, ...overlay.cost };
  }
  if (base.modalities || overlay.modalities) {
    merged.modalities = { ...base.modalities, ...overlay.modalities };
  }
  return merged;
}

function cloneProvider(p: ModelsDevProvider): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    models[mid] = { ...m };
  }
  return { ...p, models };
}

/** Drop keys whose value is `undefined` so they don't clobber base fields. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}
