/**
 * Unified next-steps suggestion parser.
 *
 * Three code paths feed into the suggestion store:
 *   1. TUI rendering  — entry.tsx parses "💡 Next steps" or "<next_steps>" from assistant output
 *   2. REPL store     — repl.ts parses "💡 Next steps" or "<next_steps>" from final agent output
 *   3. /suggest output — suggest.ts parses LLM-generated numbered lists
 *
 * Heading mode (`requireHeading = true`):
 *   strict=true  — only 💡 emoji heading or <next_steps> tag (TUI rendering)
 *   strict=false — 💡, ##, plain "Next steps", or <next_steps> headings (REPL store)
 *
 * Raw mode (`requireHeading = false`):
 *   Parses numbered/bullet items from anywhere in text (subagent /suggest output).
 *
 * Supported formats:
 *   💡 Next steps     (old emoji format)
 *   ## Next steps     (markdown heading)
 *   Next steps        (plain text)
 *   <next_steps>      (new XML tag format - preferred)
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface ParsedNextStep {
  index: number;
  text: string;
  /** Whether this item has auto="true" attribute for YOLO+auto autonomy mode. */
  auto?: boolean;
}

export interface ParseNextStepsResult {
  /** Matched steps with their original index and stripped text. */
  steps: ParsedNextStep[];
  /** Flat string array — what gets stored in the suggestion store. */
  texts: string[];
  /**
   * Content with the entire "💡 Next steps" or "<next_steps>" block removed.
   * Used by entry.tsx to strip suggestions from the rendered message body.
   */
  stripped: string;
  /** Flat string array — texts of items with auto="true" attribute only. */
  autoTexts: string[];
}

// ── Patterns ───────────────────────────────────────────────────────────────

/** Matches the 💡 emoji heading OR <next_steps> tag before numbered items. */
const STRICT_HEADING_RE = /(?:💡\s*Next steps?|<next_steps>)\s*\n+/i;

/** Heading patterns tried in non-strict (permissive) mode. */
const PERMISSIVE_HEADING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /💡\s*Next steps?\s*\n+/i, label: 'emoji' },
  { re: /##?\s*Next steps?\s*\n+/i, label: 'markdown' },
  { re: /\n{1,2}Next steps?\s*\n+/i, label: 'plain' },
  { re: /<next_steps>\s*\n+/i, label: 'xml-tag' },
];

/** Matches an item line: "1. text", "1) text", "- text", "* text". */
/** Also captures optional auto="true" attribute at the end. */
const ITEM_RE = /^(?:(\d+)[.)]\s*|[-*•]\s*)(.+?)(\s+auto="true")?$/;

const MAX_STEPS = 6;

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse "<next_steps>" or "💡 Next steps" blocks from assistant output (or raw numbered lines).
 *
 * @param content        — raw assistant message text or subagent output
 * @param strict        — when true, accepts 💡 emoji heading OR <next_steps> XML tag (TUI rendering).
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
    const hasAuto = !!m[3]; // auto="true" captured in group 3
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1; // bullet items get sequential indices
    }

    if (seenNumbers.has(index)) continue;
    if (text.length < 3) continue;
    seenNumbers.add(index);
    steps.push({ index, text, auto: hasAuto });

    if (steps.length >= MAX_STEPS) break;
  }

  return {
    steps,
    texts: steps.map((s) => s.text),
    stripped: content,
    autoTexts: steps.filter((s) => s.auto).map((s) => s.text),
  };
}

/** Parse a heading + item block (the main assistant-message path). */
function parseWithHeading(content: string, strict: boolean): ParseNextStepsResult {
  const headingRe = strict ? STRICT_HEADING_RE : buildPermissiveHeadingRe();
  const headingMatch = headingRe.exec(content);

  if (!headingMatch) {
    return { steps: [], texts: [], stripped: content, autoTexts: [] };
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
    const hasAuto = !!m[3]; // auto="true" captured in group 3
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1;
    }

    if (seenNumbers.has(index)) continue;
    if (text.length < 3) continue;
    seenNumbers.add(index);
    steps.push({ index, text, auto: hasAuto });

    if (steps.length >= MAX_STEPS) break;
  }

  if (steps.length === 0) {
    return { steps: [], texts: [], stripped: content, autoTexts: [] };
  }

  const texts = steps.map((s) => s.text);
  const autoTexts = steps.filter((s) => s.auto).map((s) => s.text);

  // Strip the entire heading + block from the content
  const blockStart = headingMatch.index;
  const blockEnd = headingEnd + findBlockEnd(afterHeading, steps.length);
  const stripped =
    (content.slice(0, blockStart) + content.slice(blockStart + blockEnd))
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  return { steps, texts, stripped, autoTexts };
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
    
    // XML closing tag — consume it and end block
    if (line === '</next_steps>') {
      consumed += rawLine.length + 1;
      break;
    }
    
    if (!line) { consumed += rawLine.length + 1; continue; }

    const m = ITEM_RE.exec(line);
    if (!m) break; // non-item line — block ends

    consumed += rawLine.length + 1;
    found++;
    if (found >= stepCount) break;
  }

  return consumed;
}
