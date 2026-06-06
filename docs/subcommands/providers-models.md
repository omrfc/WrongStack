# `wstack providers` / `wstack models`

## `wstack providers`

Lists all configured providers from `config.json`.

```text
anthropic     configured  env: ANTHROPIC_API_KEY
openai        not configured
google        not configured
```

## `wstack models`

Lists available models for a provider:

```bash
wstack models                  # list for configured provider
wstack models anthropic        # list for specific provider
wstack models refresh          # force-refresh the models.dev cache
```

Refresh fetches fresh model data from models.dev and updates `~/.wrongstack/cache/models.dev.json`.

## Code reference

- `packages/cli/src/subcommands/handlers/providers-models.ts`
- `packages/core/src/models/models-registry.ts`
- `packages/core/src/models/llm-selector.ts`
