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

  // In strict mode, if the heading was the <next_steps> XML form, require
  // the closing tag — malformed XML should be rejected so the webui
  // (which renders the same block) doesn't show raw text. The legacy 💡 /
  // ## / plain "Next steps" form has no closing tag and is always accepted.
  const headingWasXmlTag = headingMatch[0]!.startsWith('<');
  if (strict && headingWasXmlTag && !afterHeading.includes('</next_steps>')) {
    return { steps: [], texts: [], stripped: content, autoTexts: [] };
  }

  const texts = steps.map((s) => s.text);
  const autoTexts = steps.filter((s) => s.auto).map((s) => s.text);

  // Strip the entire heading + block from the content. The block to strip
  // is everything from the heading's start to the end of the closing tag
  // (or end of the last item, for the legacy 💡 / ## form). `blockEnd` is
  // the LENGTH of that block, so `content.slice(blockStart + blockEnd)` is
  // the rest of the content.
  const blockStart = headingMatch.index;
  const blockEnd = headingMatch[0]!.length + findBlockEnd(afterHeading, steps.length);
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

/**
 * Find the byte offset in `afterHeading` where the block ends.
 *
 * The block to strip is the items (one per line) plus the optional
 * `</next_steps>` closing tag (and the trailing newline after it). For the
 * legacy `💡` / `##` heading form, only the items are consumed. For the
 * `<next_steps>` form, the closing tag is consumed too.
 *
 * Returns the byte offset of the first character AFTER the block. The
 * caller's `content.slice(0, blockStart) + content.slice(blockStart + offset)`
 * then produces the stripped content.
 *
 * Walks line-by-line. Stops at the first non-item line, the closing XML
 * tag, or the end of the input — whichever comes first.
 */
function findBlockEnd(afterHeading: string, stepCount: number): number {
  // Fast path: if the block is the <next_steps> XML form, find the closing
  // tag and return its end (consuming the tag + trailing newline).
  const closeIdx = afterHeading.indexOf('</next_steps>');
  if (closeIdx !== -1) {
    let end = closeIdx + '</next_steps>'.length;
    if (afterHeading[end] === '\n') end += 1;
    return end;
  }

  // Legacy heading form (💡 / ## / plain "Next steps"): no closing tag.
  // Consume `stepCount` item lines.
  const lines = afterHeading.split('\n');
  let consumed = 0;
  let found = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) break; // blank line ends the block

    const m = ITEM_RE.exec(line);
    if (!m) break; // non-item line ends the block

    consumed += rawLine.length + 1; // +1 for the \n separator
    found++;
    if (found >= stepCount) {
      // Don't include the trailing newline of the last item — the slice
      // logic in the caller handles whitespace cleanup.
      consumed -= 1;
      break;
    }
  }

  return consumed;
}

/**
 * Strip <next_steps>...</next_steps> blocks from subagent output text.
 * Subagent results should not contain suggestion blocks — those belong to
 * the main assistant's output. This prevents raw XML tags from appearing
 * as literal text in the fleet panel.
 */
export function stripNextStepsBlock(text: string): string {
  // Match <next_steps>...</next_steps> or <next_steps/> (self-closing)
  // The block may span multiple lines.
  return text
    .replace(/<next_steps\b[^>]*>[\s\S]*?<\/next_steps>/gi, '')
    .replace(/<next_steps\b[^>]*\/?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
