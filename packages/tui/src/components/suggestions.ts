/**
 * Unified next-steps suggestion parser.
 *
 * Three code paths feed into the suggestion store:
 *   1. TUI rendering  — entry.tsx parses "💡 Next steps" from assistant output
 *   2. REPL store     — repl.ts parses "💡 Next steps" from final agent output
 *   3. /suggest output — suggest.ts parses LLM-generated numbered lists
 *
 * Heading mode (`requireHeading = true`):
 *   strict=true  — only 💡 emoji heading (TUI rendering)
 *   strict=false — 💡, ##, plain "Next steps" headings (REPL store)
 *
 * Raw mode (`requireHeading = false`):
 *   Parses numbered/bullet items from anywhere in text (subagent /suggest output).
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface ParsedNextStep {
  index: number;
  text: string;
}

export interface ParseNextStepsResult {
  /** Matched steps with their original index and stripped text. */
  steps: ParsedNextStep[];
  /** Flat string array — what gets stored in the suggestion store. */
  texts: string[];
  /**
   * Content with the entire "💡 Next steps" block removed.
   * Used by entry.tsx to strip suggestions from the rendered message body.
   */
  stripped: string;
}

// ── Patterns ───────────────────────────────────────────────────────────────

/** Matches the 💡 emoji heading before numbered items. */
const STRICT_HEADING_RE = /💡\s*Next steps?\s*\n+/i;

/** Heading patterns tried in non-strict (permissive) mode. */
const PERMISSIVE_HEADING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /💡\s*Next steps?\s*\n+/i, label: 'emoji' },
  { re: /##?\s*Next steps?\s*\n+/i, label: 'markdown' },
  { re: /\n{1,2}Next steps?\s*\n+/i, label: 'plain' },
];

/** Matches an item line: "1. text", "1) text", "- text", "* text". */
const ITEM_RE = /^(?:(\d+)[.)]\s*|[-*•]\s*)(.+)$/;

const MAX_STEPS = 6;

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse "💡 Next steps" blocks from assistant output (or raw numbered lines).
 *
 * @param content        — raw assistant message text or subagent output
 * @param strict        — when true, only the 💡 emoji heading is accepted (TUI rendering).
 *                        when false, also accepts ## / plain "Next steps" headings (REPL store).
 * @param requireHeading — when true, a heading must precede the item list.
 *                        when false, numbered/bullet items are parsed from anywhere in text
 *                        (used by /suggest subagent output which has no heading).
 */
export function parseNextSteps(
  content: string,
  strict = false,
  requireHeading = true,
): ParseNextStepsResult {
  if (requireHeading) {
    return parseWithHeading(content, strict);
  }
  return parseRawNumbered(content);
}

/** Parse numbered/bullet items from raw text without a heading. */
function parseRawNumbered(content: string): ParseNextStepsResult {
  const lines = content.split('\n');
  const steps: ParsedNextStep[] = [];
  const seenNumbers = new Set<number>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = ITEM_RE.exec(line);
    if (!m) continue; // skip non-item lines in raw mode

    const numPart = m[1];
    let text = m[2]!.trim();
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1; // bullet items get sequential indices
    }

    if (seenNumbers.has(index)) continue;
    if (text.length < 3) continue;
    seenNumbers.add(index);
    steps.push({ index, text });

    if (steps.length >= MAX_STEPS) break;
  }

  return { steps, texts: steps.map((s) => s.text), stripped: content };
}

/** Parse a heading + item block (the main assistant-message path). */
function parseWithHeading(content: string, strict: boolean): ParseNextStepsResult {
  const headingRe = strict ? STRICT_HEADING_RE : buildPermissiveHeadingRe();
  const headingMatch = headingRe.exec(content);

  if (!headingMatch) {
    return { steps: [], texts: [], stripped: content };
  }

  const headingEnd = headingMatch.index + headingMatch[0]!.length;
  const afterHeading = content.slice(headingEnd);
  const lines = afterHeading.split('\n');
  const steps: ParsedNextStep[] = [];
  const seenNumbers = new Set<number>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = ITEM_RE.exec(line);
    if (!m) break; // non-item line — block ends

    const numPart = m[1];
    let text = m[2]!.trim();
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1;
    }

    if (seenNumbers.has(index)) continue;
    if (text.length < 3) continue;
    seenNumbers.add(index);
    steps.push({ index, text });

    if (steps.length >= MAX_STEPS) break;
  }

  if (steps.length === 0) {
    return { steps: [], texts: [], stripped: content };
  }

  const texts = steps.map((s) => s.text);

  // Strip the entire heading + block from the content
  const blockStart = headingMatch.index;
  const blockEnd = headingEnd + findBlockEnd(afterHeading, steps.length);
  const stripped =
    (content.slice(0, blockStart) + content.slice(blockStart + blockEnd))
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  return { steps, texts, stripped };
}

function buildPermissiveHeadingRe(): RegExp {
  const variants = PERMISSIVE_HEADING_PATTERNS.map(({ re }) => `(?:${re.source})`).join('|');
  return new RegExp(variants, 'i');
}

function findBlockEnd(afterHeading: string, stepCount: number): number {
  const lines = afterHeading.split('\n');
  let consumed = 0;
  let found = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { consumed += rawLine.length + 1; continue; }

    const m = ITEM_RE.exec(line);
    if (!m) break;

    consumed += rawLine.length + 1;
    found++;
    if (found >= stepCount) break;
  }

  return consumed;
}
