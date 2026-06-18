// Per-tool glyph + color for the TUI.
//
// The terminal can't render SVGs, so each canonical ToolIconId maps to a single
// unicode glyph here. The COLOR comes from the shared `TOOL_ICON_CONFIG`
// (`@wrongstack/tools/tool-icons`) — the exact same hex the WebUI uses — so both
// surfaces stay in sync. Color is the primary differentiator: even if a glyph
// doesn't render in some font, the color still carries tool identity.
//
// Add new tools to TOOL_ICON_MAP in @wrongstack/tools, not here — this table is
// keyed by ToolIconId, which already covers every built-in.

import { getToolIcon, TOOL_ICON_CONFIG, type ToolIconId } from '@wrongstack/tools/tool-icons';

/**
 * Canonical ToolIconId → single-width terminal glyph. Chosen from ranges with
 * broad monospace coverage (Geometric Shapes / Dingbats / Math Operators).
 */
export const TOOL_GLYPHS: Record<ToolIconId, string> = {
  file: '▤',
  edit: '✎',
  search: '⌕',
  folder: '▣',
  terminal: '▸',
  web: '◈',
  git: '⎇',
  tree: '☰',
  code: '⚙',
  test: '⚗',
  package: '⬢',
  document: '☷',
  scaffold: '✱',
  todo: '☐',
  plan: '❖',
  task: '▪',
  meta: '❏',
  index: '⊛',
  json: '⌗',
  diff: '∆',
  logs: '≡',
  settings: '⚙',
  brain: '✦',
  fallback: '•',
};

export interface ToolVisual {
  /** Single-width terminal glyph for the tool. */
  glyph: string;
  /** Canonical hex color (same value the WebUI uses). */
  color: string;
}

/**
 * Resolve a tool name to its `{ glyph, color }` for TUI rendering.
 * Unknown / MCP / plugin tools fall back to the neutral `•` glyph + gray color.
 */
export function getToolVisual(name: string): ToolVisual {
  const id = getToolIcon(name);
  return { glyph: TOOL_GLYPHS[id], color: TOOL_ICON_CONFIG[id].color };
}
