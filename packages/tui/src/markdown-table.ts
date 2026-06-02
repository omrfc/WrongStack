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
  sepWidths?: (number | null)[],
): number[] {
  // Each column adds `│ … ` of overhead (2 padding + 1 separator); the
  // very first column also gets an opening `│`. Net overhead = 3*cols + 1.
  const overhead = 3 * cols + 1;
  const avail = Math.max(cols * MIN_COL_WIDTH, maxWidth - overhead);
  const natural = new Array<number>(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      const w = longestWord(cell); // visual width of the longest word in this cell
      const total = strWidth(cell); // visual width of the entire cell content
      // Ensure the column is at least wide enough for the longest word,
      // and at least wide enough for the full cell content.
      natural[c] = Math.max(natural[c]!, w, total);
    }
  }
  // Apply separator widths as minimums (markdown separator defines column widths).
  if (sepWidths) {
    for (let c = 0; c < cols && c < sepWidths.length; c++) {
      const sepW = sepWidths[c];
      if (sepW != null) {
        natural[c] = Math.max(natural[c]!, sepW);
      }
    }
  }
  const sumNatural = natural.reduce((s, n) => s + n, 0);
  if (sumNatural <= avail) return natural;
  // Need to shrink. Repeatedly steal a char from the widest column above
  // MIN_COL_WIDTH until we fit. Cheap; cols is small.
  const widths = natural.slice();
  let sum = sumNatural;
  while (sum > avail) {
    let maxIdx = -1;
    let maxVal = MIN_COL_WIDTH;
    for (let i = 0; i < cols; i++) {
      const w = widths[i]!;
      if (w > maxVal) {
        maxVal = w;
        maxIdx = i;
      }
    }
    if (maxIdx < 0) break; // every column is at MIN_COL_WIDTH; give up
    widths[maxIdx]!--;
    sum--;
  }
  return widths;
}

const MIN_COL_WIDTH = 4;

/**
 * Return the number of terminal columns a string occupies.
 * Uses East Asian Width property to determine character widths:
 * - Emoji (U+1F000+ and various other emoji blocks) count as 2 columns.
 * - Full-width (F) and Wide (W) characters count as 2 columns.
 * - ASCII printable characters count as 1.
 * - Control characters count as 0.
 */
export function strWidth(s: string): number {
  let width = 0;
  for (const cp of s) {
    const code = cp.codePointAt(0)!;
    // Control characters: no width
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue;
    }
    // Emoji: Most emoji render as double-width in terminals.
    // Modern emoji are in U+1F000+ or various other blocks.
    if (
      code >= 0x1f000 || // Supplementary Pictographs (U+1F000-U+1FFFF)
      (code >= 0x2600 && code <= 0x27bf) || // Miscellaneous Symbols, Dingbats
      (code >= 0x2300 && code <= 0x23ff) || // Miscellaneous Technical
      (code >= 0x2b50 && code <= 0x2b55) || // Stars and similar
      (code >= 0x2934 && code <= 0x2935) || // Arrow forms
      (code >= 0x2190 && code <= 0x21ff) || // Arrows
      (code >= 0x25a0 && code <= 0x25ff) || // Geometric Shapes
      (code >= 0x25c0 && code <= 0x25fe) || // More Geometric Shapes (includes ▶)
      (code >= 0x2700 && code <= 0x27bf) // Dingbats (includes ✅ ❌)
    ) {
      width += 2;
      continue;
    }
    // East Asian Width: Wide characters take 2 columns.
    // CJK Unified Ideographs, Hiragana, Katakana, Hangul, etc.
    if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
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
      continue;
    }
    // ASCII and most other printable characters: 1 column
    width += 1;
  }
  return width;
}

function longestWord(s: string): number {
  let max = 0;
  for (const w of s.split(/\s+/)) {
    const visualWidth = strWidth(w);
    if (visualWidth > max) max = visualWidth;
  }
  return max;
}

function border(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
}

function renderRow(cells: string[], widths: number[], aligns: Align[]): string[] {
  const wrapped = cells.map((c, i) => wrapCell(c, widths[i] ?? MIN_COL_WIDTH));
  const height = Math.max(1, ...wrapped.map((w) => w.length));
  const out: string[] = [];
  for (let line = 0; line < height; line++) {
    const parts: string[] = [];
    for (let c = 0; c < widths.length; c++) {
      const w = widths[c] ?? MIN_COL_WIDTH;
      const text = wrapped[c]?.[line] ?? '';
      parts.push(padCell(text, w, aligns[c] ?? 'left'));
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
