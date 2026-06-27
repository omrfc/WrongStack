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
| `/prompts add --category <c> --description "<d>" --tags <a,b> --var <name:desc> "title" "content"` | Add with structured fields + `{{variables}}` |

### Variable richness

A `--var` spec is `name:description`, optionally followed by a `::meta` suffix:

- `::multiline` — the value is multi-line (pasted code, a diff); surfaces render a textarea.
- `::enum=a|b|c` — closed value set; surfaces render a dropdown and an out-of-range value is rejected.

Example: `--var "code:Paste the snippet::multiline,flavor:Regex flavor::enum=PCRE|JS|Python"`

> Disable the whole subsystem with `features.prompts: false` in config (defaults to on).

| `/prompts new "title" "content"` | Alias for `add` |
| `/prompts favorite <slug-or-title>` | Mark a prompt favorite (copies a builtin into your user layer) |
| `/prompts export [path]` | Write your user prompts to a JSON file (default `wrongstack-prompts.json`) |
| `/prompts import <path>` | Import prompts from a JSON file into your user layer (overwrites by slug) |
| `/prompts delete <title>` | Delete the best matching prompt |
| `/prompts rm <title>` | Alias for `delete` |
| `/prompts edit "title" "new content"` | Replace prompt content |
| `/prompts update "title" "new content"` | Alias for `edit` |
| `/prompts extend "title" <instructions>` | Use the active LLM provider to improve an existing prompt |

## Code Reference

- `packages/core/src/plugins/prompts-plugin.ts`
- `packages/core/src/storage/prompt-store.ts`
