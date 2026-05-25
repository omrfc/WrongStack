// Bracketed-paste accumulation, factored out of the TUI key handler so the
// (fiddly) marker logic can be unit-tested in isolation.
//
// A terminal in bracketed-paste mode wraps pasted text as
// `\x1b[200~<content>\x1b[201~`. The OS/terminal can split that across
// several stdin reads, and Ink's keypress parser sometimes strips the ESC
// byte — leaving a bare `[200~` / `[201~`. So we:
//   - detect both the ESC-prefixed and bare marker forms,
//   - buffer fragments across calls until the closing marker arrives,
//   - hand back the fully-assembled payload exactly once.

const BEGIN = '[200~';
const END = '[201~';
// biome-ignore lint/suspicious/noControlCharactersInRegex: paste markers carry a literal ESC
const BEGIN_RE = /\x1b?\[200~/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: paste markers carry a literal ESC
const END_RE = /\x1b?\[201~/g;

export interface PasteFeedResult {
  /** New accumulator state: a string while mid-paste, `null` when idle. */
  accum: string | null;
  /**
   * The fully-assembled paste payload when an end marker closed it, else
   * `null` (still buffering).
   */
  complete: string | null;
}

/**
 * Feed one keypress fragment into the paste accumulator.
 *
 * @param accum current accumulator (`null` when not inside a paste)
 * @param input the raw keypress string for this event
 * @returns `null` when `input` is not part of a paste (the caller should
 *   handle it as normal input); otherwise the updated accumulation state.
 */
export function feedPaste(accum: string | null, input: string): PasteFeedResult | null {
  if (accum === null && !input.includes(BEGIN)) return null;
  const piece = input.replace(BEGIN_RE, '').replace(END_RE, '');
  const next = (accum ?? '') + piece;
  if (input.includes(END)) return { accum: null, complete: next };
  return { accum: next, complete: null };
}
