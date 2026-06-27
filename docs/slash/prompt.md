# /prompt — Search & insert from the prompt library

Registered by the built-in `wstack-prompts` plugin. Searches the **merged**
prompt library (project + user + 100+ builtin prompts), de-duplicated by slug,
and inserts a chosen prompt into your next turn — filling any `{{variables}}`.

## Usage

| Command | Effect |
|---|---|
| `/prompt` | Overview: total count + categories |
| `/prompt <query>` | Ranked search across title/description/content/tags |
| `/prompt <slug>` | Preview one prompt |
| `/prompt insert <slug>` | Insert; prompts for any required `{{variables}}` |
| `/prompt insert <slug> key=value …` | Insert with variables pre-filled |

Source glyphs: 📦 builtin · 👤 user · 📁 project · ☁ synced.

Variables may declare an `enum` (a value outside the set is rejected with the
allowed options) or be `multiline`. When inserting, a value for an `enum`
variable must be one of its options.

In the WebUI, `/prompt` opens a searchable modal in the chat input (browse by
category, preview, fill variables, insert) — `enum` variables render as a
dropdown and `multiline` ones as a textarea. In the TUI, a bare `/prompt` opens
a visual picker (↑/↓ navigate · ←/→ cycle category · Enter inserts the prompt's
content into the input buffer, leaving `{{variables}}` for inline filling · Esc).

The library can be disabled entirely with `features.prompts: false` in config
(defaults to on).

## Related

- `/prompts` — manage your library (add/edit/delete/favorite)
- `/prompt-gen` — author a new prompt with AI guidance

## Code Reference

- `packages/core/src/plugins/prompts-plugin.ts`
- `packages/core/src/execution/prompt-loader.ts` (loader + `renderPrompt`)
- `packages/webui/src/components/PromptLibraryModal.tsx`
