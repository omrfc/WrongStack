import { Box, Text } from './ink.js';
import type React from 'react';
import { detectTable, renderTable } from './markdown-table.js';
import { theme } from './theme.js';

// Lightweight markdown renderer for assistant prose. Handles inline emphasis
// (**bold**, *italic*, `code`, ~~strike~~) plus block constructs (ATX headings,
// bullet / numbered lists, blockquotes) and defers GitHub tables to the
// existing box-drawing table renderer. Fenced code blocks are handled upstream
// by AssistantBody before this sees the text.
//
// Like the syntax highlighter, emphasis is expressed as Ink <Text> props
// (bold/italic/color), never raw ANSI, so width measurement stays correct.

export interface InlineToken {
  text: string;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  code?: boolean | undefined;
  strike?: boolean | undefined;
}

/**
 * Memoization cache for parseInline. Lines of assistant prose are frequently
 * identical across re-renders (the same heading, bullet prefix, or repeated
 * prose), and the char-by-char + indexOf parsing is O(n²) per line. Caching
 * turns repeated lines into O(1) lookups. LRU-evicted at 5000 entries to cap
 * memory — a typical session rarely exceeds a few thousand unique lines.
 */
const _parseCache = new Map<string, InlineToken[]>();
const _PARSE_CACHE_MAX = 5000;

/**
 * Parse one line of prose into inline-emphasis tokens. Markers are stripped
 * (this is display text, not length-preserving). `_..._` is intentionally NOT
 * treated as italic so snake_case / file_names aren't mangled. An unterminated
 * marker is emitted literally so no text is ever lost.
 *
 * Results are memoized: repeated calls with the same text return the identical
 * cached array, eliminating redundant parsing on every TUI re-render.
 */
export function parseInline(text: string): InlineToken[] {
  const cached = _parseCache.get(text);
  if (cached) return cached;

  const tokens: InlineToken[] = [];
  let plain = '';
  let i = 0;
  const flush = () => {
    if (plain) {
      tokens.push({ text: plain });
      plain = '';
    }
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    const two = text.slice(i, i + 2);

    // `inline code` — highest precedence, no inner parsing.
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
    }
    // **bold**
    if (two === '**') {
      const close = text.indexOf('**', i + 2);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
    }
    // ~~strike~~
    if (two === '~~') {
      const close = text.indexOf('~~', i + 2);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 2, close), strike: true });
        i = close + 2;
        continue;
      }
    }
    // *italic* — single asterisk only (the `**` case is handled above).
    if (ch === '*' && text[i + 1] !== '*') {
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) {
        flush();
        tokens.push({ text: text.slice(i + 1, close), italic: true });
        i = close + 1;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();

  // LRU eviction: when near capacity, drop the oldest quarter.
  if (_parseCache.size >= _PARSE_CACHE_MAX) {
    let dropped = 0;
    const target = Math.floor(_PARSE_CACHE_MAX / 4);
    for (const key of _parseCache.keys()) {
      _parseCache.delete(key);
      if (++dropped >= target) break;
    }
  }
  _parseCache.set(text, tokens);
  return tokens;
}

function InlineLine({ tokens, dim }: { tokens: InlineToken[]; dim?: boolean | undefined }): React.ReactElement {
  if (tokens.length === 0) return <Text> </Text>;
  return (
    <Text>
      {tokens.map((t, j) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable per line
          key={j}
          color={t.code ? theme.accent : 'white'}
          bold={Boolean(t.bold)}
          italic={Boolean(t.italic)}
          strikethrough={Boolean(t.strike)}
          dimColor={Boolean(dim)}
        >
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

/**
 * Render assistant prose with markdown emphasis + block formatting. Tables are
 * routed through the existing box-drawing renderer; everything else is parsed
 * line-by-line.
 *
 * `contentWidth` is the real inner width of the panel that wraps this view
 * (the assistant entry's left-border + paddingLeft). When provided, tables
 * are sized against it so they don't overflow the panel; otherwise we fall
 * back to `termWidth`, which is correct for callers without a bordered
 * container. Non-table prose is unaffected — Ink handles its soft wrap.
 */
export function MarkdownView({
  text,
  termWidth,
  contentWidth,
}: {
  text: string;
  termWidth: number;
  /** Real inner width of the surrounding panel. Defaults to `termWidth`. */
  contentWidth?: number | undefined;
}): React.ReactElement {
  const lines = text.split('\n');
  const rows: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  // Tables are the only width-sensitive path here; size them to the real
  // content area so a 2-col-chrome border (assistant panel) doesn't push
  // the last cell off the right edge and force an Ink wrap.
  const tableBudget = Math.max(20, contentWidth ?? termWidth);
  while (i < lines.length) {
    // GitHub table block → existing renderer.
    const tableEnd = detectTable(lines, i);
    if (tableEnd > i) {
      // Tables render box-drawing characters that conflict with the message
      // panel background. Render them in a transparent box so they are not
      // affected by the parent entry's backgroundColor.
      rows.push(
        <Box key={`t${key++}`} width={tableBudget} backgroundColor="transparent">
          <Text>{renderTable(lines.slice(i, tableEnd), tableBudget)}</Text>
        </Box>,
      );
      i = tableEnd;
      continue;
    }
    const line = lines[i] ?? '';
    i += 1;

    const heading = line.match(HEADING_RE);
    if (heading) {
      rows.push(
        <Text key={`h${key++}`} bold color={theme.accent}>
          {heading[2] ?? ''}
        </Text>,
      );
      continue;
    }
    const quote = line.match(QUOTE_RE);
    if (quote && line.startsWith('>')) {
      const qContent = quote[1] ?? '';
      rows.push(
        <Box key={`q${key++}`} flexDirection="row">
          <Text dimColor>{'  '}</Text>
          {/[\u2500-\u257F]/.test(qContent) ? (
            // Box-drawing characters inside blockquotes also need transparent
            // background to avoid inheriting the message panel background.
            <Box flexDirection="row" backgroundColor="transparent">
              {[...qContent].slice(0, (contentWidth ?? termWidth) - 2).map((ch, ci) => (
                /* biome-ignore lint/suspicious/noArrayIndexKey: characters are not reorderable */
                <Text key={ci} dimColor>{ch}</Text>
              ))}
            </Box>
          ) : (
            <InlineLine tokens={parseInline(qContent)} dim />
          )}
        </Box>,
      );
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      rows.push(
        <Box key={`b${key++}`} flexDirection="row">
          <Text color={theme.accent}>{`${bullet[1] ?? ''}• `}</Text>
          <InlineLine tokens={parseInline(bullet[2] ?? '')} />
        </Box>,
      );
      continue;
    }
    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      rows.push(
        <Box key={`n${key++}`} flexDirection="row">
          <Text color={theme.accent}>{`${numbered[1] ?? ''}${numbered[2]}. `}</Text>
          <InlineLine tokens={parseInline(numbered[3] ?? '')} />
        </Box>,
      );
      continue;
    }

    // Box-drawing characters (U+2500–U+257F) have East Asian Width
    // "Ambiguous" and are often measured as 2-column by terminal width
    // libraries (including Ink's internal measurement). Rendering them
    // character-by-character inside a row prevents incorrect wrapping.
    if (/[\u2500-\u257F]/.test(line)) {
      const maxW = contentWidth ?? termWidth;
      const chars = [...line].slice(0, maxW);
      // Box-drawing characters (U+2500-U+257F) inherit the message panel
      // background, making them visually unclear. Wrap in a transparent box
      // so they render on the terminal default background, matching tables.
      rows.push(
        <Box key={`bx${key++}`} width={maxW} backgroundColor="transparent" flexDirection="row">
          {chars.map((ch, ci) => (
            /* biome-ignore lint/suspicious/noArrayIndexKey: characters are not reorderable */
            <Text key={ci}>{ch}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    rows.push(<InlineLine key={`p${key++}`} tokens={parseInline(line)} />);
  }
  return <Box flexDirection="column">{rows}</Box>;
}
