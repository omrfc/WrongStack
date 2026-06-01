# Curated model-catalog overlay (`providers.json`)

`providers.json` is a **curated override layer** that WrongStack deep-merges **on top of**
the live `https://models.dev/api.json` catalog. models.dev stays the base/primary source; this
file lets us **add** providers/models it doesn't carry and **fix** fields it gets wrong (a missing
model, a stale context limit, etc.) without waiting for an upstream fix or a release.

At runtime the registry resolves:

```
merged = mergeModelsPayload(modelsDev, providers.json)   // overlay wins
```

It is loaded from (first non-empty wins):
1. this file fetched from our GitHub raw URL (so it can refresh between releases), then
2. this file bundled in the installed package (offline floor).

If models.dev is completely unreachable and there's no cache, a **non-empty** overlay still drives
the catalog on its own. An empty `{}` overlay is a safe no-op.

## Shape

Same schema as `models.dev/api.json` — a map keyed by provider id. You only include the fields you
want to add or override; everything else falls through to the base. (JSON has no comments, hence
this README.)

```jsonc
{
  // Override just one field on an existing model — here, fix a context window.
  "deepseek": {
    "models": {
      "deepseek-v4-pro": { "limit": { "context": 128000 } }
    }
  },

  // Add a provider models.dev doesn't list at all.
  "myco": {
    "id": "myco",
    "name": "My Co",
    "npm": "@ai-sdk/openai-compatible",   // determines the wire family
    "api": "https://api.myco.example/v1",
    "env": ["MYCO_API_KEY"],
    "models": {
      "myco-large": {
        "id": "myco-large",
        "name": "MyCo Large",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 16000 },
        "cost": { "input": 0.5, "output": 1.5 }
      }
    }
  }
}
```

## Merge rules

- Provider in both → overlay scalar fields (`name`, `npm`, `api`, `env`, `doc`) override the base;
  `models` are merged by id.
- Model in both → `{ ...baseModel, ...overlayModel }`, with the nested `limit` / `cost` /
  `modalities` objects merged one level deeper — so `{"limit":{"context":…}}` overrides only the
  context and keeps the base's `limit.output`.
- Anything only in the overlay is added.

## Editing / refreshing

Use the helper to seed and sanity-check entries against upstream:

```bash
pnpm run sync:models -- --extract deepseek:deepseek-v4-pro   # print a paste-ready overlay snippet
pnpm run sync:models -- --diff                               # what we override vs upstream + drift
```

Then edit `providers.json` and commit. Keep it **small and curated** — it is an override layer,
not a mirror of models.dev. Once models.dev catches up, drop the now-redundant override (`--diff`
flags those).
