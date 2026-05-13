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

function detectTable(lines: string[], start: number): number {
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

function renderTable(tableLines: string[], maxWidth: number): string {
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

  const widths = computeWidths([header, ...dataRows], cols, maxWidth);

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

function computeWidths(allRows: string[][], cols: number, maxWidth: number): number[] {
  // Each column adds `│ … ` of overhead (2 padding + 1 separator); the
  // very first column also gets an opening `│`. Net overhead = 3*cols + 1.
  const overhead = 3 * cols + 1;
  const avail = Math.max(cols * MIN_COL_WIDTH, maxWidth - overhead);
  const natural = new Array<number>(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      const w = longestWord(cell); // floor: never wrap mid-word in the middle of a short label
      const total = cell.length;
      // Track both, prefer the natural width but ensure at least `w`.
      natural[c] = Math.max(natural[c]!, total);
      if (w > natural[c]!) natural[c] = Math.min(total + 1, w);
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

function longestWord(s: string): number {
  let max = 0;
  for (const w of s.split(/\s+/)) if (w.length > max) max = w.length;
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
  if (text.length <= width) return [text];
  const out: string[] = [];
  // Split on whitespace, keep grouping until we'd overflow.
  const words = text.split(/(\s+)/);
  let cur = '';
  for (const word of words) {
    if (!word) continue;
    if (cur.length + word.length <= width) {
      cur += word;
      continue;
    }
    if (cur) {
      out.push(cur.trimEnd());
      cur = '';
    }
    if (word.length > width) {
      // Hard-break a word longer than the column.
      let rest = word;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      cur = rest;
    } else if (!/^\s+$/.test(word)) {
      cur = word;
    }
  }
  if (cur) out.push(cur.trimEnd());
  return out.length === 0 ? [''] : out;
}

function padCell(text: string, width: number, align: Align): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = width - text.length;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + text + ' '.repeat(pad - l);
  }
  return text + ' '.repeat(pad);
}
