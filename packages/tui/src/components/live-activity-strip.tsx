import { Box, Text } from 'ink';
import type React from 'react';
import type { FleetEntry } from '../app.js';

export interface LiveActivityStripProps {
  /** Per-subagent state from the FleetEntry table. */
  entries: Record<string, FleetEntry>;
  /** Re-renders every tick so elapsed timers stay live; otherwise the
   *  bar freezes between FleetEntry updates (which can be 30s+ apart
   *  if a subagent is parked in one tool). */
  nowTick: number;
  /** Optional cap on rows so a 20-subagent fleet doesn't push the
   *  input off-screen. Default 4 — matches the status bar's 4th line. */
  maxRows?: number;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function fmtRecentTool(tool: FleetEntry['recentTools'][number]): string {
  const status = tool.ok === false ? 'fail' : 'ok';
  const name = tool.name.length > 18 ? `${tool.name.slice(0, 17)}...` : tool.name;
  const parts = [status, name];
  if (typeof tool.durationMs === 'number') parts.push(fmtElapsed(tool.durationMs));
  if (typeof tool.outputBytes === 'number' && tool.outputBytes > 0) parts.push(fmtBytes(tool.outputBytes));
  if (typeof tool.outputLines === 'number' && tool.outputLines > 0) parts.push(`${tool.outputLines}L`);
  return parts.join(' ');
}

function fmtRecentMessage(message: FleetEntry['recentMessages'][number]): string {
  const text = message.text.replace(/\s+/g, ' ');
  return text.length > 48 ? `${text.slice(0, 47)}...` : text;
}

/**
 * Compact one-line-per-subagent strip that sits directly above the
 * input area. Shows only RUNNING subagents — completed/failed entries
 * already surfaced as history rows and don't need to crowd the
 * always-visible band.
 *
 * Each row carries: `→ <label> <currentTool?> (elapsed) · <iter>it
 * <tool>tc`. The currentTool segment updates on `tool.started` /
 * `tool.executed` so the user can tell at a glance "AGENT#1 has been
 * inside `bash` for 12s now" without grep-tailing the JSONL.
 *
 * Renders nothing when no subagents are running, so the input area
 * sits flush against history during idle / solo work.
 */
export function LiveActivityStrip({
  entries,
  nowTick,
  maxRows = 4,
}: LiveActivityStripProps): React.ReactElement | null {
  const running = Object.values(entries)
    .filter((e) => e.status === 'running')
    // Stable order: oldest-started first, so the strip doesn't shuffle
    // every time a tool starts/ends on one of the rows.
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, maxRows);
  if (running.length === 0) return null;

  // Reference nowTick so React knows we depend on it — otherwise the
  // 1s ticker won't re-render the elapsed values.
  void nowTick;
  const now = Date.now();

  return (
    <Box flexDirection="column" paddingX={1}>
      {running.map((e) => {
        const toolElapsed = e.currentTool ? now - e.currentTool.startedAt : 0;
        const taskElapsed = now - e.startedAt;
        const toolSeg = e.currentTool
          ? `→ ${e.currentTool.name} (${fmtElapsed(toolElapsed)})`
          : 'idle between tools';
        const recentTools = (e.recentTools ?? []).slice(-2).map(fmtRecentTool).join(' | ');
        const messageText =
          e.streamingText.trim() || (e.recentMessages ?? []).slice(-1).map(fmtRecentMessage).join('');
        return (
          <Box key={e.id} flexDirection="row" gap={1}>
            <Text color="cyan">●</Text>
            <Text>{e.name.slice(0, 14).padEnd(14)}</Text>
            <Text dimColor>·</Text>
            <Text color={e.currentTool ? 'green' : 'yellow'}>{toolSeg}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>
              {e.iterations}it {e.toolCalls}tc · {fmtElapsed(taskElapsed)}
            </Text>
            {recentTools ? (
              <>
                <Text dimColor>|</Text>
                <Text dimColor>last: {recentTools}</Text>
              </>
            ) : null}
            {messageText ? (
              <>
                <Text dimColor>|</Text>
                <Text dimColor>msg: {fmtRecentMessage({ text: messageText, at: Date.now() })}</Text>
              </>
            ) : null}
          </Box>
        );
      })}
      {Object.values(entries).filter((e) => e.status === 'running').length > maxRows ? (
        <Box paddingLeft={2}>
          <Text dimColor>
            …+{Object.values(entries).filter((e) => e.status === 'running').length - maxRows} more
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
