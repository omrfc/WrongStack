# /prompts - Personal Prompt Library

Registered by the built-in `wstack-prompts` plugin. Stores reusable prompts in
the project/user prompt store and can ask the active LLM provider to extend an
existing prompt.

## Usage

| Command | Effect |
|---|---|
| `/prompts` | List stored prompts |
| `/prompts list` | Same as `/prompts` |
| `/prompts ls` | Alias for `list` |
| `/prompts view <title>` | Show the best matching prompt |
| `/prompts show <title>` | Alias for `view` |
| `/prompts add "title" "content"` | Add a prompt |
| `/prompts new "title" "content"` | Alias for `add` |
| `/prompts delete <title>` | Delete the best matching prompt |
| `/prompts rm <title>` | Alias for `delete` |
| `/prompts edit "title" "new content"` | Replace prompt content |
| `/prompts update "title" "new content"` | Alias for `edit` |
| `/prompts extend "title" <instructions>` | Use the active LLM provider to improve an existing prompt |

## Code Reference

- `packages/core/src/plugins/prompts-plugin.ts`
- `packages/core/src/storage/prompt-store.ts`
