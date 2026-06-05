/**
 * Tool output serialization utilities.
 * Extracted from Agent.executeTools to allow reuse and consistent output handling.
 */

export interface ToolOutputSerializerOptions {
  perIterationOutputCapBytes?: number;
  estimator?: (text: string) => number;
}

export function createToolOutputSerializer(opts: ToolOutputSerializerOptions = {}) {
  const capBytes = opts.perIterationOutputCapBytes ?? 100_000;

  function serialize(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      if (Array.isArray(value)) return value.map(serialize).join('\n');
      if ('text' in (value as Record<string, unknown>)) {
        const t = (value as Record<string, unknown>).text;
        return typeof t === 'string' ? t : JSON.stringify(value, null, 2);
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function enforceCap(text: string, remainingBudget: number): { text: string; newBudget: number } {
    if (remainingBudget <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes <= remainingBudget) {
      return { text, newBudget: remainingBudget - textBytes };
    }
    const marker = `\n…[truncated ${textBytes - remainingBudget} bytes]…\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const available = remainingBudget - markerBytes;
    if (available <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const half = Math.floor(available / 2);
    const first = text.slice(0, half);
    const second = text.slice(text.length - half);
    return { text: `${first}${marker}${second}`, newBudget: 0 };
  }

  return { serialize, enforceCap, capBytes };
}

/**
 * Render a tool result body for inclusion in the `tool.executed` event.
 * Tool outputs can be large (file dumps, command output); UIs only want a
 * preview line, so cap at ~400 chars with an ellipsis marker.
 */
export function truncateForEvent(content: string, max = 400): string {
  if (!content) return '';
  return content.length <= max ? content : `${content.slice(0, max - 1)}…`;
}

/**
 * Derive size signals (bytes / tokens / lines) for the chip rendered beside
 * each tool result. Computed once over the FULL `content` BEFORE the
 * 400-char event preview is taken.
 *
 *  - bytes: UTF-8 byte length (multi-byte aware).
 *  - tokens: standard ~3.5 chars/token heuristic.
 *  - lines: read prefixes lines with `<n>→`; for shell/grep/logs we fall
 *    back to a newline count. Undefined for tools without a line notion.
 */
export function sizeSignals(
  toolName: string | undefined,
  content: string,
): { outputBytes: number; outputTokens: number; outputLines: number | undefined } {
  if (!content || content.length === 0) {
    return { outputBytes: 0, outputTokens: 0, outputLines: undefined };
  }
  const outputBytes = Buffer.byteLength(content, 'utf8');
  const outputTokens = Math.max(1, Math.round(outputBytes / 3.5));
  let outputLines: number | undefined;
  if (toolName === 'read') {
    const lineRe = /^\s*\d+→/gm;
    let count = 0;
    while (lineRe.exec(content) !== null) count++;
    if (count > 0) outputLines = count;
  } else if (
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'grep' ||
    toolName === 'logs'
  ) {
    let nl = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl++;
    outputLines = nl + (content.endsWith('\n') ? 0 : 1);
  }
  return { outputBytes, outputTokens, outputLines };
}
