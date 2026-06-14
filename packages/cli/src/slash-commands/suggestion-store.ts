/**
 * Shared suggestion store for /suggest and /next slash commands.
 *
 * Previously, suggestions were stored in a closure variable (`currentSuggestions`)
 * inside cli-main.ts, accessed via the `onSuggestions` callback on
 * `SlashCommandContext`. This closure-based approach works correctly in the REPL
 * but can fail in the TUI when the callback goes through multiple indirections
 * (SlashCommandRegistry → SlashCommand.run → closed-over opts).
 *
 * By using a module-level store, both /suggest (writer) and /next (reader)
 * access the same array directly, bypassing the callback indirection entirely.
 * The CLI's `onSuggestions` callback now reads/writes this shared store to
 * maintain backward compatibility with the REPL autonomy loop's
 * `getSuggestions`/`onSuggestionsParsed` flow.
 *
 * Auto suggestions (items with auto="true" attribute) are stored separately
 * for YOLO+auto autonomy mode.
 */

let sharedSuggestions: string[] = [];
let sharedAutoSuggestions: string[] = [];

/** Store suggestions (called by /suggest and onSuggestionsParsed). */
export function setSuggestions(suggestions: string[]): void {
  sharedSuggestions = suggestions;
}

/** Store auto suggestions (items with auto="true" attribute). Called by onAutoSuggestionsParsed. */
export function setAutoSuggestions(suggestions: string[]): void {
  sharedAutoSuggestions = suggestions;
}

/** Retrieve current suggestions (called by /next selection and getSuggestions). */
export function getSuggestions(): string[] {
  return sharedSuggestions;
}

/** Retrieve current auto suggestions (called by YOLO+auto autonomy). */
export function getAutoSuggestions(): string[] {
  return sharedAutoSuggestions;
}

/** Clear suggestions (called by /next clear). */
export function clearSuggestions(): void {
  sharedSuggestions = [];
  sharedAutoSuggestions = [];
}
