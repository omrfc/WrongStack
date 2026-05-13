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
    const textBytesHalf = Buffer.byteLength(first, 'utf8');
    const second = text.slice(text.length - half);
    return { text: `${first}${marker}${second}`, newBudget: 0 };
  }

  return { serialize, enforceCap, capBytes };
}