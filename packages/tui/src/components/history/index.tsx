import { Box, Static, useStdout } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { AssistantTail } from './assistant.js';
import { Entry } from './entry.js';
import { MAX_STREAM_DISPLAY_CHARS, tailForDisplay } from './utils.js';
import type { HistoryProps } from './types.js';

// ── Re-exports ──

export type { HistoryEntry, HistoryProps } from './types.js';
export type { BodySegment } from './types.js';
export { Banner } from './banner.js';
export { CodeBlock, DiffBlock, type DiffLineKind, type DiffLineRow, extractDiffPreview, parseUnifiedDiff } from './code-block.js';
export { Entry } from './entry.js';
export { MESSAGE_PANEL_CHROME_WIDTH, AssistantBody, AssistantTail, assistantTailRows, splitFencedBlocks } from './assistant.js';
export {
  shortenPath,
  previewArgs,
  previewOutput,
  fmtTok,
  fmtDuration,
  fmtBytes,
  truncMid,
  stringOf,
  numOf,
  tryParseJson,
  scanNumberedRange,
  countLines,
  firstNonEmpty,
  formatMatchHit,
  formatToolArgs,
  formatToolOutput,
  ToolStreamBox,
  streamBoxRows,
  MAX_STREAM_DISPLAY_CHARS,
  tailForDisplay,
} from './utils.js';
export { assistantContentWidth } from './entry.js';

// ── History Component ──

/**
 * History component — renders committed entries via <Static> so they
 * flow into terminal scrollback, plus a live streaming assistant tail.
 */
export function History({ entries, streamingText, toolStream }: HistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    const handleResize = () => {
      setTermSize({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);
  const termWidth = termSize.columns;
  const tail = streamingText ? tailForDisplay(streamingText, MAX_STREAM_DISPLAY_CHARS) : '';

  // NOTE: the live tool-stream box (◆ <tool> ⏱ … + last N output lines) is
  // deliberately NOT rendered in inline mode. In a full terminal the live
  // region sits at the bottom edge, so every tool.progress re-render scrolls
  // the screen by a line and strands the box's top row (the "◆ bash ⏱ Xs"
  // header) permanently in native scrollback — the user sees the header
  // stacked dozens of times. Ink can't avoid this without owning the screen,
  // so the live tail belongs to the managed (alt-screen) ScrollableHistory
  // path only. Inline users still get a live "running: <tool> Xs" chip in the
  // status bar while it runs, and the full output as a committed entry when it
  // finishes — `toolStream` is intentionally unused here.
  void toolStream;

  return (
    <>
      <Static items={entries}>
        {(entry) => (
          <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0}>
            <Entry entry={entry} termWidth={termWidth} />
          </Box>
        )}
      </Static>
      {tail ? <AssistantTail text={tail} termWidth={termWidth} /> : null}
    </>
  );
}
