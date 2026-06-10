/**
 * Interactive project picker for the CLI.
 *
 * Renders an arrow-navigable, scrollable menu listing known projects,
 * plus actions like "Start new session" and "Previous sessions".
 * Uses raw terminal input to capture arrow keys and Enter.
 *
 * @module project-picker
 */
import { color } from '@wrongstack/core';
import type { ProjectEntry } from './slash-commands/project-utils.js';
import { loadManifest } from './slash-commands/project-utils.js';

// ── ANSI constants ────────────────────────────────────────────────────────

const CSI = '\x1b[';
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR_SCREEN = `${CSI}2J`;
const CURSOR_HOME = `${CSI}H`;

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_UP_ALT = '\x1bOA';
const ARROW_DOWN_ALT = '\x1bOB';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const ENTER = '\r';
const CTRL_C = '\x03';
const ESC = '\x1b';
const BS = '\x7f';
const Q = 'q';

// ── Types ─────────────────────────────────────────────────────────────────

export interface PickerItem {
  key: string;         // unique identifier
  label: string;       // primary display line
  subtitle?: string | undefined; // secondary dim line (e.g. path)
  meta?: string | undefined;     // right-aligned info (e.g. "yesterday")
  kind: 'project' | 'action';
}

export interface PickerConfig {
  title: string;
  items: PickerItem[];
  globalConfigPath?: string | undefined;
}

export interface PickerResult {
  kind: 'project' | 'action';
  key: string;
  /** Resolved project entry (only set when kind === 'project') */
  project?: ProjectEntry | undefined;
  /** Action identifier: 'new-session', 'prev-sessions', 'quit' */
  action?: 'new-session' | 'prev-sessions' | 'quit' | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtLastSeen(iso: string | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Get the terminal height, defaulting to 24 if it can't be determined.
 */
function terminalHeight(): number {
  return process.stdout.rows || 24;
}

/**
 * Build the picker items from the projects manifest plus built-in actions.
 */
export async function buildPickerItems(opts: {
  globalConfigPath?: string | undefined;
  currentProjectRoot?: string | undefined;
}): Promise<PickerItem[]> {
  const manifest = await loadManifest(opts.globalConfigPath);
  const sorted = [...manifest.projects].sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.name.localeCompare(b.name);
  });

  const items: PickerItem[] = [];

  for (const p of sorted) {
    const isCurrent = p.root === opts.currentProjectRoot;
    const marker = isCurrent ? '●' : ' ';
    items.push({
      key: p.slug,
      label: `${marker} ${p.name}`,
      subtitle: p.root,
      meta: fmtLastSeen(p.lastSeen),
      kind: 'project',
    });
  }

  // Divider + action items
  items.push(
    { key: '__divider__', label: '─'.repeat(32), kind: 'action' },
    { key: 'new-session', label: '+  Start new session', kind: 'action', meta: 'current project' },
    { key: 'prev-sessions', label: '⏱  Previous sessions', kind: 'action', meta: 'resume' },
    { key: 'quit', label: 'q  Quit', kind: 'action' },
  );

  return items;
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderPickerFrame(
  items: PickerItem[],
  selectedIdx: number,
  scrollOffset: number,
  visibleHeight: number,
  title: string,
  filter: string,
  out: NodeJS.WriteStream,
): void {
  const width = out.columns || 80;
  const pad = ' '.repeat(2);

  // Clear screen and move home
  out.write(CLEAR_SCREEN);
  out.write(CURSOR_HOME);

  // Title
  out.write(`\n${pad}${color.bold(color.amber(title))}\n`);

  // Search/filter bar — always visible when filter is non-empty
  if (filter.length > 0) {
    out.write(`${pad}${color.cyan('Filter:')} ${filter}${color.dim('█')}\n`);
    // Divider after filter bar
    const divider = color.dim('─'.repeat(Math.min(width - 4, 60)));
    out.write(`${pad}${divider}\n`);
  } else {
    // Normal divider
    const divider = color.dim('─'.repeat(Math.min(width - 4, 60)));
    out.write(`${pad}${divider}\n`);
  }

  // Empty state
  if (items.length === 0) {
    if (filter.length > 0) {
      out.write(`\n${pad}${color.dim('No projects match your filter.')}\n`);
      out.write(`${pad}${color.dim('Press ESC to clear filter, or backspace to refine.')}\n`);
    } else {
      out.write(`\n${pad}${color.dim('No projects registered.')}\n`);
      out.write(`${pad}${color.dim('Use /project add <path> to register one.')}\n`);
    }
    return;
  }

  // Adjust visible height: filter bar adds 2 lines (filter line + divider)
  const filterOverhead = filter.length > 0 ? 2 : 0;
  const effectiveVisible = Math.max(3, visibleHeight - filterOverhead);
  const maxIdx = Math.min(items.length, scrollOffset + effectiveVisible);

  for (let i = scrollOffset; i < maxIdx; i++) {
    const item = items[i];
    if (!item) continue;

    const isSelected = i === selectedIdx;
    const prefix = isSelected ? color.bold(color.cyan(' ▸ ')) : '   ';

    if (item.key === '__divider__') {
      out.write(`\n${pad}${color.dim(item.label)}\n`);
      continue;
    }

    // Build the line: [marker] label … meta
    const labelText = isSelected ? color.bold(item.label) : item.label;
    const metaText = item.meta ? color.dim(`  ${item.meta}`) : '';

    // Truncate subtitle if too long
    let sub = '';
    if (item.subtitle) {
      const maxSub = width - 10;
      const truncated = item.subtitle.length > maxSub
        ? `…${item.subtitle.slice(item.subtitle.length - maxSub + 1)}`
        : item.subtitle;
      sub = `\n${pad}       ${color.dim(truncated)}`;
    }

    const line = `${prefix} ${labelText}${metaText}`;
    out.write(`${line}${sub}\n`);
  }

  // Scroll indicator
  if (items.length > effectiveVisible) {
    const pct = Math.round((scrollOffset / Math.max(1, items.length - effectiveVisible)) * 100);
    out.write(`\n${pad}${color.dim(`↑ ${scrollOffset + 1}-${Math.min(scrollOffset + effectiveVisible, items.length)} of ${items.length} (${pct}%) ↓`)}\n`);
  }

  // Footer hint — context-sensitive
  if (filter.length > 0) {
    out.write(`\n${pad}${color.dim('type to filter   ↑↓ navigate   ↵ select   ESC clear   Ctrl+C quit')}\n`);
  } else {
    out.write(`\n${pad}${color.dim('type to filter   ↑↓ navigate   PgUp PgDn page   ↵ select   q quit')}\n`);
  }
}

/**
 * Filter items by a case-insensitive substring match against label and subtitle.
 * Only project items are filtered; action items and dividers always appear.
 *
 * @public — exported for testing
 */
export function filterItems(allItems: PickerItem[], filter: string): PickerItem[] {
  if (filter.length === 0) return allItems;

  const lower = filter.toLowerCase();
  const projectItems = allItems.filter((item) => {
    if (item.kind !== 'project') return true; // actions/dividers pass through
    const labelMatch = item.label.toLowerCase().includes(lower);
    const subMatch = item.subtitle?.toLowerCase().includes(lower);
    return labelMatch || subMatch;
  });

  // If filter yields no project results, still show action items + divider
  // So the user can ESC clear or quit
  return projectItems;
}

/**
 * Compute the effective visible height accounting for the filter bar overhead.
 *
 * @public — exported for testing
 */
export function effectiveVisibleHeight(baseVisibleHeight: number, filter: string): number {
  const overhead = filter.length > 0 ? 2 : 0; // filter bar + its divider
  return Math.max(3, baseVisibleHeight - overhead);
}

/**
 * Skip divider items at the given index, moving forward or backward.
 * Returns the adjusted index, clamped to bounds.
 *
 * @public — exported for testing
 */
export function skipDivider(items: PickerItem[], idx: number, direction: -1 | 1): number {
  let i = idx;
  while (i >= 0 && i < items.length && items[i]?.key === '__divider__') {
    i += direction;
  }
  return Math.max(0, Math.min(items.length - 1, i));
}

/**
 * Run the interactive project picker. Returns the selection or undefined on cancel.
 */
export async function runProjectPicker(opts: {
  globalConfigPath?: string | undefined;
  currentProjectRoot?: string | undefined;
}): Promise<PickerResult | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;

  if (!stdin.isTTY || !out.isTTY) {
    // Non-TTY fallback: return undefined (caller should provide a usable message)
    return undefined;
  }

  const allItems = await buildPickerItems(opts);
  if (allItems.length === 0) return undefined;

  const title = 'Project Switch';
  const reservedTop = 4;    // title + divider + padding
  const reservedBottom = 3; // scroll indicator + footer
  const headerHeight = reservedTop + reservedBottom;
  const baseVisibleHeight = Math.max(5, terminalHeight() - headerHeight);

  return new Promise<PickerResult | undefined>((resolve) => {
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    let filter = '';
    let displayItems = allItems;
    let selectedIdx = 0;
    let scrollOffset = 0;
    let buf = '';

    const visibleHeight = () => effectiveVisibleHeight(baseVisibleHeight, filter);

    const render = () => {
      renderPickerFrame(displayItems, selectedIdx, scrollOffset, visibleHeight(), title, filter, out);
    };

    const applyFilter = (newFilter: string) => {
      filter = newFilter;
      displayItems = filterItems(allItems, filter);
      // Reset position to top
      selectedIdx = 0;
      scrollOffset = 0;
      // Skip divider at position 0
      if (displayItems[0]?.key === '__divider__') {
        selectedIdx = skipDivider(displayItems, selectedIdx, 1);
      }
    };

    const navigateDown = () => {
      if (selectedIdx < displayItems.length - 1) {
        selectedIdx = skipDivider(displayItems, selectedIdx + 1, 1);
      }
      const vh = visibleHeight();
      if (selectedIdx >= scrollOffset + vh) {
        scrollOffset = selectedIdx - vh + 1;
      }
    };

    const navigateUp = () => {
      if (selectedIdx > 0) {
        selectedIdx = skipDivider(displayItems, selectedIdx - 1, -1);
      }
      if (selectedIdx < scrollOffset) {
        scrollOffset = selectedIdx;
      }
    };

    const pageUp = () => {
      const pageSize = Math.max(1, visibleHeight() - 1);
      const target = selectedIdx - pageSize;
      selectedIdx = Math.max(0, target);
      selectedIdx = skipDivider(displayItems, selectedIdx, -1);
      if (selectedIdx < scrollOffset) {
        scrollOffset = Math.max(0, selectedIdx - 1);
      }
    };

    const pageDown = () => {
      const pageSize = Math.max(1, visibleHeight() - 1);
      const target = selectedIdx + pageSize;
      selectedIdx = Math.min(displayItems.length - 1, target);
      selectedIdx = skipDivider(displayItems, selectedIdx, 1);
      const vh = visibleHeight();
      if (selectedIdx >= scrollOffset + vh) {
        scrollOffset = Math.min(
          displayItems.length - vh,
          selectedIdx - vh + 1,
        );
        if (scrollOffset < 0) scrollOffset = 0;
      }
    };

    const cleanup = () => {
      stdin.off('data', onData);
      if (wasRaw) {
        try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      }
      if (wasPaused) stdin.pause();
      out.write(CURSOR_SHOW);
    };

    /**
     * Check if a single character is printable (should be added to filter).
     * Excludes control characters (0x00-0x1F) and DEL (0x7F).
     */
    const isPrintable = (ch: string): boolean => {
      if (ch.length !== 1) return false;
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code < 0x7f;
    };

    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      buf += str;

      // Escape sequences (ESC + [...])
      if (buf.startsWith(ESC) && buf.length >= 3) {
        // ── 4-byte sequences (PageUp/Down: ESC [ 5/6 ~) ─────────
        if (buf.length >= 4) {
          if (buf === PAGE_UP) { buf = ''; pageUp(); render(); return; }
          if (buf === PAGE_DOWN) { buf = ''; pageDown(); render(); return; }
        }

        // ── 3-byte sequences (arrows: ESC [ A / B / O A / O B) ──
        if (buf.length === 3) {
          if (buf === ARROW_UP || buf === ARROW_UP_ALT) { buf = ''; navigateUp(); render(); return; }
          if (buf === ARROW_DOWN || buf === ARROW_DOWN_ALT) { buf = ''; navigateDown(); render(); return; }
        }

        // Known lengths but unknown sequence — let it buffer more
        if (buf.length < 4) return;

        // Unknown escape sequence — clear buffer
        buf = '';
        return;
      }

      // Single-byte inputs
      if (buf.length === 1) {
        const ch = buf;

        // Ctrl+C — always quit
        if (ch === CTRL_C) {
          cleanup();
          out.write(CURSOR_SHOW);
          out.write('\n');
          resolve(undefined);
          return;
        }

        // Escape
        if (ch === ESC) {
          if (filter.length > 0) {
            // First ESC clears the filter
            applyFilter('');
            buf = '';
            render();
            return;
          }
          // No filter active — quit
          cleanup();
          out.write(CURSOR_SHOW);
          out.write('\n');
          resolve(undefined);
          return;
        }

        // Backspace — remove last char from filter
        if (ch === BS || ch === '\b') {
          if (filter.length > 0) {
            applyFilter(filter.slice(0, -1));
          }
          buf = '';
          render();
          return;
        }

        // Enter/Return
        if (ch === ENTER) {
          const item = displayItems[selectedIdx];
          cleanup();
          out.write(CURSOR_SHOW);
          out.write('\n');

          if (!item || item.key === '__divider__') {
            resolve(undefined);
            return;
          }

          if (item.key === 'quit') {
            resolve(undefined);
            return;
          }

          if (item.key === 'new-session') {
            resolve({ kind: 'action', key: 'new-session', action: 'new-session' });
            return;
          }

          if (item.key === 'prev-sessions') {
            resolve({ kind: 'action', key: 'prev-sessions', action: 'prev-sessions' });
            return;
          }

          // Project item
          resolve({ kind: 'project', key: item.key });
          return;
        }

        // Special single-char navigation (only when filter is empty)
        if (filter.length === 0) {
          if (ch === 'q' || ch === 'Q') {
            cleanup();
            out.write(CURSOR_SHOW);
            out.write('\n');
            resolve(undefined);
            return;
          }
          if (ch === 'j') { buf = ''; navigateDown(); render(); return; }
          if (ch === 'k') { buf = ''; navigateUp(); render(); return; }
        }

        // Printable character → add to filter
        if (isPrintable(ch)) {
          applyFilter(filter + ch);
          buf = '';
          render();
          return;
        }

        buf = '';
        return;
      }
    };

    // Setup raw mode
    try {
      stdin.setRawMode(true);
    } catch {
      // Can't set raw mode — fallback
      resolve(undefined);
      return;
    }
    stdin.resume();
    out.write(CURSOR_HIDE);

    // Skip divider items to start on a valid entry
    selectedIdx = skipDivider(displayItems, 0, 1);

    // Initial render
    render();

    stdin.on('data', onData);

    // Handle stdin close (pipe broken, etc.)
    stdin.once('close', () => {
      cleanup();
      out.write(CURSOR_SHOW);
      resolve(undefined);
    });
  });
}
