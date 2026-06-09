import { expectDefined } from '@wrongstack/core/utils';

/**
 * Scan a body of prose for GitHub-flavoured markdown tables and replace
 * each one with a Unicode box-drawing rendering that fits the terminal
 * width. Cells that overflow their column wrap over multiple lines.
 *
 * Non-table prose passes through unchanged.
 *
 * Input shape (rest of the doc may surround it):
 *   | Header A | Header B |
 *   |----------|---------:|
 *   | a 1      |       42 |
 *   | a 2      |        7 |
 *
 * Output shape:
 *   ┌──────────┬──────────┐
 *   │ Header A │ Header B │
 *   ├──────────┼──────────┤
 *   │ a 1      │       42 │
 *   │ a 2      │        7 │
 *   └──────────┴──────────┘
 */
export function renderMarkdownTables(text: string, maxWidth: number): string {
  if (!text.includes('|')) return text; // fast path
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const end = detectTable(lines, i);
    if (end > i) {
      out.push(renderTable(lines.slice(i, end), Math.max(20, maxWidth)));
      i = end;
    } else {
      out.push(lines[i] ?? '');
      i++;
    }
  }
  return out.join('\n');
}

type Align = 'left' | 'right' | 'center';

const ROW_RE = /^\s*\|.*\|\s*$/;
const SEP_RE = /^\s*\|[\s\-:|]+\|\s*$/;

export function detectTable(lines: string[], start: number): number {
  if (start + 1 >= lines.length) return start;
  if (!ROW_RE.test(lines[start] ?? '')) return start;
  const sep = lines[start + 1] ?? '';
  // Need at least one dash somewhere — distinguishes the separator from
  // a regular row that happens to contain colons/spaces only.
  if (!SEP_RE.test(sep) || !/-/.test(sep)) return start;
  let end = start + 2;
  while (end < lines.length && ROW_RE.test(lines[end] ?? '')) end++;
  return end;
}

function parseCells(line: string): string[] {
  // Strip the outer pipes, then split on remaining pipes. Pipes inside a
  // cell would need escaping with `\|`; we honour that minimally.
  const inner = line.trim().replace(/^\||\|$/g, '');
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((c) => c.trim());
}

function parseAlign(sep: string): Align {
  const t = sep.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * Extract visual widths from a separator row (e.g., "|------|--------|").
 * Counts dash characters as the minimum width for each column.
 * Returns null for cells that don't look like valid separators.
 */
function parseSeparatorWidths(sepCells: string[]): (number | null)[] {
  return sepCells.map((cell) => {
    const trimmed = cell.trim();
    // Must be dashes only (possibly with colons for alignment).
    const dashes = trimmed.replace(/:/g, '');
    if (/^-+$/.test(dashes)) return dashes.length;
    return null;
  });
}

export function renderTable(tableLines: string[], maxWidth: number): string {
  const header = parseCells(tableLines[0] ?? '');
  const sepCells = parseCells(tableLines[1] ?? '');
  const cols = header.length;
  const aligns: Align[] = [];
  for (let c = 0; c < cols; c++) {
    aligns.push(parseAlign(sepCells[c] ?? ''));
  }
  const dataRows = tableLines.slice(2).map(parseCells);
  // Normalise short rows by padding with empty cells; drop extras.
  for (const row of dataRows) {
    while (row.length < cols) row.push('');
    row.length = cols;
  }

  // Parse separator widths to use as minimum column widths.
  const sepWidths = parseSeparatorWidths(sepCells);
  const widths = computeWidths([header, ...dataRows], cols, maxWidth, sepWidths);

  const lines: string[] = [];
  lines.push(border('┌', '┬', '┐', widths));
  lines.push(...renderRow(header, widths, aligns));
  lines.push(border('├', '┼', '┤', widths));
  for (const row of dataRows) {
    lines.push(...renderRow(row, widths, aligns));
  }
  lines.push(border('└', '┴', '┘', widths));
  return lines.join('\n');
}

function computeWidths(
  allRows: string[][],
  cols: number,
  maxWidth: number,
  sepWidths?: (number | null)[] | undefined,
): number[] {
  // Each column adds `│ … ` of overhead (2 padding + 1 separator); the
  // very first column also gets an opening `│`. Net overhead = 3*cols + 1.
  const overhead = 3 * cols + 1;
  const avail = Math.max(cols * MIN_COL_WIDTH, maxWidth - overhead);
  const natural = new Array<number>(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      // Use visible width (stripped markers) so **bold** contributes 4, not 8.
      // Only measure total content width — wrapCell will hard-break long words
      // when the column shrinks below a word's length. This lets narrow terminals
      // still render wide tables by wrapping cells across multiple rows.
      const stripped = stripInlineMarkers(cell);
      const total = strWidth(stripped);
      natural[c] = Math.max(expectDefined(natural[c]), total);
    }
  }
  // Apply separator widths as minimums (markdown separator defines column widths).
  if (sepWidths) {
    for (let c = 0; c < cols && c < sepWidths.length; c++) {
      const sepW = sepWidths[c];
      if (sepW != null) {
        natural[c] = Math.max(expectDefined(natural[c]), sepW);
      }
    }
  }
  const sumNatural = natural.reduce((s, n) => s + n, 0);
  if (sumNatural <= avail) return natural;
  // Need to shrink. Repeatedly steal a char from the widest column above
  // MIN_COL_WIDTH until we fit. Columns can shrink below word boundaries —
  // wrapCell handles hard-breaking mid-word when forced.
  const widths = natural.slice();
  let sum = sumNatural;
  while (sum > avail) {
    let maxIdx = -1;
    let maxVal = MIN_COL_WIDTH;
    for (let i = 0; i < cols; i++) {
      const w = expectDefined(widths[i]);
      if (w > maxVal) {
        maxVal = w;
        maxIdx = i;
      }
    }
    if (maxIdx < 0) break; // every column is at MIN_COL_WIDTH; give up
    widths[maxIdx] = (widths[maxIdx] ?? 0) - 1;
    sum--;
  }
  return widths;
}

const MIN_COL_WIDTH = 4;

// ---------------------------------------------------------------------------
// Ligature breaker — prevents font-level ligatures from misaligning tables
// ---------------------------------------------------------------------------

/**
 * Character pairs that commonly form ligatures in programming fonts
 * (Fira Code, Cascadia Code, JetBrains Mono, etc.). When these sequences
 * appear in table cells, the font renders them as a single-glyph arrow or
 * symbol, collapsing 2 terminal columns into 1 visual column and breaking
 * Unicode box-drawing alignment.
 *
 * We insert U+200B ZERO WIDTH SPACE between the two characters. This
 * invisible breaker prevents the ligature without adding visual width
 * (strWidth \u200B = 0), so the alignment math stays correct.
 */
const LIGATURE_PAIRS: Array<[string, string]> = [
  ['-', '>'],  // →  arrow
  ['<', '-'],  // ←
  ['=', '>'],  // ⇒
  ['<', '='],  // ≤
  ['>', '='],  // ≥
  ['!', '='],  // ≠
  ['=', '='],  // equality (some fonts)
  ['~', '>'],  // ⇝
  ['<', '~'],  // ⇜
];

const ZWSP = '\u200B'; // zero-width space

/**
 * Insert zero-width spaces between known ligature-prone character pairs
 * so that the font renders each character individually. Only applied inside
 * table cells; code blocks and prose pass through unchanged.
 */
export function breakLigatures(text: string): string {
  // Fast path: skip if no ligature-initiating characters present.
  if (!/[-<=>!~]/.test(text)) return text;

  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += text[i];
    if (i + 1 >= text.length) break;
    for (const [a, b] of LIGATURE_PAIRS) {
      if (text[i] === a && text[i + 1] === b) {
        result += ZWSP;
        break;
      }
    }
  }
  return result;
}

/**
 * Return the number of terminal columns a string occupies.
 *
 * Handles Unicode properly:
 * - ANSI escape sequences (SGR codes like \x1b[1m, \x1b[0m) are zero-width.
 * - ZWJ emoji sequences (👨‍👩‍👧, 🧑‍🏫) count as 2 columns total.
 * - Variation selectors (U+FE0F, U+FE0E) contribute zero width.
 * - Zero-width characters (ZWJ U+200D, ZWSP U+200B, etc.) contribute zero width.
 * - Emoji blocks count as 2 columns.
 * - East Asian Wide/Fullwidth characters count as 2 columns.
 * - ASCII printable characters count as 1.
 * - Control characters count as 0.
 */
export function strWidth(s: string): number {
  let width = 0;
  const len = s.length;
  let i = 0;
  while (i < len) {
    // Skip ANSI escape sequences — they contribute zero visual width.
    // SGR codes: \x1b[ … m  (with optional ;-separated parameters)
    // Also handle OSC (\x1b]), CSI sequences beyond SGR.
    if (s[i] === '\x1b' && i + 1 < len && s[i + 1] === '[') {
      i += 2; // skip \x1b[
      while (i < len && s[i] !== 'm') i++; // skip to terminator
      if (i < len) i++; // skip the 'm'
      continue;
    }

    const code = expectDefined(s.codePointAt(i));
    const cpLen = code > 0xffff ? 2 : 1; // surrogate pair = single code point

    // Zero-width characters — contribute nothing to visual width.
    if (
      code === 0x200d || // ZWJ — Zero Width Joiner (emoji sequences)
      code === 0x200b || // ZWSP — Zero Width Space
      code === 0x200c || // ZWNJ — Zero Width Non-Joiner
      code === 0x200e || // LRM — Left-to-Right Mark
      code === 0x200f || // RLM — Right-to-Left Mark
      code === 0x2060 || // WJ — Word Joiner
      code === 0xfeff || // BOM / ZWNBSP
      (code >= 0xfe00 && code <= 0xfe0f) || // Variation Selectors 1–16
      (code >= 0xe0100 && code <= 0xe01ef) // Variation Selectors Supplement
    ) {
      i += cpLen;
      continue;
    }

    // Control characters: no width
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      i += cpLen;
      continue;
    }

    // Combining marks, enclosing marks, modifiers — zero width on their own
    // (they combine with preceding base character).
    if (
      (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
      (code >= 0x1ab0 && code <= 0x1aff) || // Combining Diacritical Marks Extended
      (code >= 0x1dc0 && code <= 0x1dff) || // Combining Diacritical Marks Supplement
      (code >= 0x20d0 && code <= 0x20ff) || // Combining Diacritical Marks for Symbols
      (code >= 0xfe20 && code <= 0xfe2f) // Combining Half Marks
    ) {
      i += cpLen;
      continue;
    }

    // Emoji: Most emoji render as double-width in terminals.
    // NOTE: Arrows (U+2190–U+21FF) are deliberately NOT included here —
    // characters like ←↑→↓ (U+2190–U+2193) are "Ambiguous" East Asian
    // Width and render as 1 column in virtually all terminal fonts.
    if (
      code >= 0x1f000 || // Supplementary Pictographs (U+1F000-U+1FFFF)
      (code >= 0x2600 && code <= 0x27bf) || // Miscellaneous Symbols, Dingbats
      (code >= 0x2300 && code <= 0x23ff) || // Miscellaneous Technical
      (code >= 0x2b50 && code <= 0x2b55) || // Stars and similar
      (code >= 0x2934 && code <= 0x2935) || // Arrow forms
      (code >= 0x25a0 && code <= 0x25ff) || // Geometric Shapes
      (code >= 0x25c0 && code <= 0x25fe) || // More Geometric Shapes (includes ▶)
      (code >= 0x2700 && code <= 0x27bf) // Dingbats (includes ✅ ❌)
    ) {
      width += 2;
      i += cpLen;
      continue;
    }
    // East Asian Width: Wide characters take 2 columns.
    if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      code === 0x2329 || code === 0x232a || // Angle brackets
      (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals Supplement
      (code >= 0x3040 && code <= 0xa4cf) || // Hiragana, Katakana, CJK
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaf9) || // CJK Compatibility Ideographs
      (code >= 0xfe10 && code <= 0xfe1f) || // Vertical forms
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Halfwidth and Fullwidth Forms
      (code >= 0x20000 && code <= 0x2fffd) || // CJK Extension B+
      (code >= 0x30000 && code <= 0x3fffd) // CJK Extension F+
    ) {
      width += 2;
      i += cpLen;
      continue;
    }
    // Box-drawing characters (U+2500–U+257F) — render as 1 column in
    // virtually all modern terminal emulators. Explicitly listed here
    // rather than falling through to default to prevent ambiguity.
    if (code >= 0x2500 && code <= 0x257f) {
      width += 1;
      i += cpLen;
      continue;
    }

    // ASCII and most other printable characters: 1 column
    width += 1;
    i += cpLen;
  }
  return width;
}

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
}

// ─── Inline markdown in table cells ─────────────────────────────────────────

/**
 * Strip inline formatting markers from text for width calculation.
 * Removes `**`, `*`, `` ` ``, `~~` markers so `strWidth` measures only
 * the visible text, not the markup characters.
 */
function stripInlineMarkers(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // *italic*
    .replace(/`(.+?)`/g, '$1') // `code`
    .replace(/~~(.+?)~~/g, '$1'); // ~~strike~~
}

// ANSI SGR codes for terminal text styling inside <Text> strings.
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
// Pastel cyan (#94e2d5, Catppuccin teal) as a truecolor SGR so inline `code`
// in table cells matches the rest of the pastel palette instead of the
// terminal's harsh ANSI cyan (\x1b[36m). See theme.ts / ink.tsx.
const ANSI_CYAN = '\x1b[38;2;148;226;213m';
const ANSI_STRIKE = '\x1b[9m';
const ANSI_RESET_ALL = '\x1b[0m';

/**
 * Convert inline markdown markers to ANSI escape codes for styled display
 * inside table cells. Ink's `<Text>` component passes ANSI through, so we
 * get bold/italic/code/strikethrough styling without breaking the box-drawing
 * geometry (ANSI codes are zero-width).
 */
function applyInlineAnsi(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET_ALL}`)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ANSI_DIM}$1${ANSI_RESET_ALL}`)
    .replace(/`(.+?)`/g, `${ANSI_CYAN}$1${ANSI_RESET_ALL}`)
    .replace(/~~(.+?)~~/g, `${ANSI_STRIKE}$1${ANSI_RESET_ALL}`);
}

function renderRow(cells: string[], widths: number[], aligns: Align[]): string[] {
  // Apply ANSI formatting for inline markdown, then break ligatures.
  const styled = cells.map((c) => applyInlineAnsi(c));
  const safe = styled.map((c) => breakLigatures(c));
  // Wrap and pad based on VISIBLE width (stripped markers), but display styled text.
  const wrapped = safe.map((c, i) => wrapCell(c, widths[i] ?? MIN_COL_WIDTH));
  const height = Math.max(1, ...wrapped.map((w) => w.length));
  const out: string[] = [];
  for (let line = 0; line < height; line++) {
    const parts: string[] = [];
    for (let c = 0; c < widths.length; c++) {
      const w = widths[c] ?? MIN_COL_WIDTH;
      const text = wrapped[c]?.[line] ?? '';
      // Append full ANSI reset after the cell content so the │ border
      // between cells never inherits styling from the cell text.
      // The reset (ANSI_RESET_ALL = \x1b[0m) has zero visual width,
      // so `padCell`'s measurement stays correct.
      parts.push(padCell(text, w, aligns[c] ?? 'left') + ANSI_RESET_ALL);
    }
    out.push('│ ' + parts.join(' │ ') + ' │');
  }
  return out;
}

function wrapCell(text: string, width: number): string[] {
  if (strWidth(text) <= width) return [text];
  const out: string[] = [];
  // Split on whitespace, keep grouping until we'd overflow.
  const words = text.split(/(\s+)/);
  let cur = '';
  let curWidth = 0;
  for (const word of words) {
    if (!word) continue;
    const wordWidth = strWidth(word);
    if (curWidth + wordWidth <= width) {
      cur += word;
      curWidth += wordWidth;
      continue;
    }
    if (cur) {
      out.push(padVisual(cur, width));
      cur = '';
      curWidth = 0;
    }
    if (wordWidth > width) {
      // Hard-break a word longer than the column — slice by visual width.
      let rest = word;
      let restWidth = wordWidth;
      while (restWidth > width) {
        // Collect characters until we reach `width` visual columns.
        let collected = '';
        let collectedWidth = 0;
        for (const cp of rest) {
          const cpWidth = strWidth(cp);
          if (collectedWidth + cpWidth > width) break;
          collected += cp;
          collectedWidth += cpWidth;
        }
        out.push(padVisual(collected, width));
        rest = rest.slice([...collected].join('').length);
        restWidth = strWidth(rest);
      }
      cur = rest;
      curWidth = strWidth(rest);
    } else if (!/^\s+$/.test(word)) {
      cur = word;
      curWidth = wordWidth;
    }
  }
  if (cur) out.push(padVisual(cur, width));
  return out.length === 0 ? [''] : out;
}

/** Pad a string to a target visual width using spaces. */
function padVisual(text: string, targetWidth: number): string {
  const w = strWidth(text);
  if (w >= targetWidth) {
    // Truncate to targetWidth visual columns, iterating code points.
    let taken = 0;
    let endIdx = 0;
    for (const cp of text) {
      const cpw = strWidth(cp);
      if (taken + cpw > targetWidth) break;
      taken += cpw;
      endIdx += [...cp].join('').length;
    }
    return text.slice(0, endIdx);
  }
  return text + ' '.repeat(targetWidth - w);
}

function padCell(text: string, width: number, align: Align): string {
  const visualLen = strWidth(text);
  // Pad (or truncate) text so its visual width equals `width`.
  // This matches how `border` creates `─`.repeat(width + 2) dashes,
  // which gives a visual content width of `width` columns.
  let displayText = text;
  if (visualLen > width) {
    // Truncate to visual width — iterate code points, stop when we'd exceed target.
    let takenWidth = 0;
    let endIdx = 0;
    for (const cp of text) {
      const cpWidth = strWidth(cp);
      if (takenWidth + cpWidth > width) break;
      takenWidth += cpWidth;
      endIdx += [...cp].join('').length;
    }
    displayText = text.slice(0, endIdx);
  }
  const pad = width - strWidth(displayText);
  if (align === 'right') return ' '.repeat(pad) + displayText;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + displayText + ' '.repeat(pad - l);
  }
  return displayText + ' '.repeat(pad);
}
