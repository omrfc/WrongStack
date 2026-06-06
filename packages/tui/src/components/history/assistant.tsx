import { Box, Text } from 'ink';
import type React from 'react';
import { type Lang, detectLang } from '../../highlight.js';
import { MarkdownView } from '../../markdown.js';
import { theme } from '../../theme.js';
import { CodeBlock } from './code-block.js';
import type { BodySegment } from './types.js';

/**
 * Horizontal columns consumed by every bordered message panel.
 * Exported so the regression test can assert against the same number
 * the Entry uses — drift between the two would silently re-introduce a bug.
 */
export const MESSAGE_PANEL_CHROME_WIDTH = 2;

/** Max code-block lines rendered before a "+N more" footer (mirrors ToolStreamBox). */

/**
 * Split assistant text into prose and ```fenced``` code segments, in order.
 * Pure + testable. An unterminated fence treats the remainder as code.
 */
export function splitFencedBlocks(text: string): BodySegment[] {
  const lines = text.split('\n');
  const segs: BodySegment[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang: Lang = 'plain';
  const flushProse = () => {
    if (prose.length > 0) {
      segs.push({ type: 'prose', text: prose.join('\n') });
      prose = [];
    }
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (code === null) {
        flushProse();
        code = [];
        lang = detectLang(fence[1] ?? '');
      } else {
        segs.push({ type: 'code', text: code.join('\n'), lang });
        code = null;
        lang = 'plain';
      }
      continue;
    }
    if (code !== null) code.push(line);
    else prose.push(line);
  }
  if (code !== null) segs.push({ type: 'code', text: code.join('\n'), lang });
  flushProse();
  return segs;
}

/**
 * Assistant message body: prose (with markdown tables) interleaved with
 * highlighted code blocks.
 */
export function AssistantBody({
  text,
  termWidth,
  contentWidth,
}: {
  text: string;
  termWidth: number;
  /** Real inner width of the surrounding panel. Defaults to `termWidth`. */
  contentWidth?: number;
}): React.ReactElement {
  const segments = splitFencedBlocks(text);
  const inner = contentWidth ?? termWidth;
  return (
    <Box flexDirection="column">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segment order is stable
          <CodeBlock key={i} code={seg.text} lang={seg.lang ?? 'plain'} contentWidth={inner} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segment order is stable
          <MarkdownView key={i} text={seg.text} termWidth={inner} />
        ),
      )}
    </Box>
  );
}

/** Rows reserved by the live assistant tail. Held constant so the streaming
 *  region never grows row-by-row (see ToolStreamBox for the why). */
const ASSISTANT_TAIL_LINES = 8;

/**
 * Build the CONSTANT-height row set for the live assistant tail: always exactly
 * `tailLines` rows (newest pinned to the bottom, blank padding on top), each
 * truncated to `contentWidth` so nothing wraps. Pure + exported for testing.
 */
export function assistantTailRows(
  text: string,
  tailLines: number,
  contentWidth: number,
): string[] {
  const tail = text.split('\n').slice(-tailLines);
  const rows: string[] = [];
  for (let i = 0; i < tailLines - tail.length; i++) rows.push('');
  for (const line of tail) {
    rows.push(line.length > contentWidth ? `${line.slice(0, contentWidth - 1)}…` : line);
  }
  return rows;
}

/**
 * The live "ASSISTANT: (streaming...)" tail shown below committed history.
 *
 * Renders at a CONSTANT height (header + ASSISTANT_TAIL_LINES rows) with every
 * line truncated to the terminal width so nothing wraps. A wrapping/growing
 * tail pinned to the bottom of the screen forces the terminal to scroll on each
 * delta, and in inline mode each scroll leaks the input prompt
 * row into permanent scrollback. Holding the height fixed limits that to one
 * scroll when streaming starts. Rows are bottom-aligned (blank padding on top)
 * so the newest line stays pinned to the bottom.
 */
export function AssistantTail({
  text,
  termWidth,
}: { text: string; termWidth: number }): React.ReactElement {
  // border (1) + paddingLeft (1) + 1 safety column against last-column autowrap.
  const contentWidth = Math.max(20, termWidth - 3);
  const rows = assistantTailRows(text, ASSISTANT_TAIL_LINES, contentWidth);
  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.assistant}
      paddingLeft={1}
    >
      <Box flexDirection="row">
        <Text bold color={theme.assistant}>
          {'ASSISTANT'}
        </Text>
        <Text dimColor>{'  (streaming…)'}</Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-height block, index is the row
          <Text key={i} color="white">{r || ' '}</Text>
        ))}
      </Box>
    </Box>
  );
}
