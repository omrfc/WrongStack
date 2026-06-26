export const DEFAULT_TUI_THINKING_WORD = 'thinking';
export const MAX_TUI_THINKING_WORD_LENGTH = 16;

/**
 * Pool of fun working-state words surfaced when the user hasn't pinned a
 * specific one. Every entry must satisfy {@link normalizeTuiThinkingWord}
 * (single token, ≤ {@link MAX_TUI_THINKING_WORD_LENGTH} chars) so it renders
 * verbatim in the statusline chip.
 */
export const TUI_THINKING_WORD_POOL = [
  'pondering',
  'cogitating',
  'ruminating',
  'noodling',
  'brewing',
  'conjuring',
  'percolating',
  'scheming',
  'tinkering',
  'vibing',
  'crafting',
  'wrangling',
  'summoning',
  'finagling',
  'marinating',
  'hatching',
  'juggling',
  'spelunking',
  'contemplating',
  'bamboozling',
  'alchemizing',
  'incubating',
  'doodling',
  'mulling',
] as const;

/**
 * Normalize the configurable statusline word shown while the TUI is working.
 * The value must be a single short word; invalid values fall back to the default.
 */
export function normalizeTuiThinkingWord(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TUI_THINKING_WORD;
  const word = value.trim();
  if (word.length === 0 || word.length > MAX_TUI_THINKING_WORD_LENGTH) {
    return DEFAULT_TUI_THINKING_WORD;
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(word)) return DEFAULT_TUI_THINKING_WORD;
  return word;
}

/**
 * Whether the configured value should resolve to a random pool word rather than
 * a fixed one. True when the user never set a word (empty/unset), left it at the
 * literal default `'thinking'`, or explicitly asked for `'random'`.
 */
export function isRandomTuiThinkingWord(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const word = value.trim().toLowerCase();
  return word.length === 0 || word === DEFAULT_TUI_THINKING_WORD || word === 'random';
}

/**
 * Pick a random word from {@link TUI_THINKING_WORD_POOL}, avoiding `previous`
 * when possible so consecutive working spells feel varied.
 */
export function pickRandomTuiThinkingWord(previous?: string): string {
  const pool = TUI_THINKING_WORD_POOL;
  const candidates = previous ? pool.filter((w) => w !== previous) : pool;
  const list = candidates.length > 0 ? candidates : pool;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] ?? list[0] ?? DEFAULT_TUI_THINKING_WORD;
}
