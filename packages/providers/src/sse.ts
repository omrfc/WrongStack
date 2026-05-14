/**
 * Minimal Server-Sent Events parser for HTTP streaming responses.
 *
 * Yields parsed events as `{ event, data }` pairs. Per spec:
 *   - Each event is separated by a blank line
 *   - `event: foo` sets the event name (defaults to "message")
 *   - `data: ...` lines accumulate into the data buffer
 *   - `:` lines are comments and ignored
 *   - `id` / `retry` fields are accepted and ignored
 *
 * For Anthropic the wire format is canonical SSE with explicit `event:` lines.
 * For OpenAI / OpenAI-compatible the format omits `event:` and just emits
 * `data: <json>` chunks, with a final `data: [DONE]`. Both work with this
 * parser; consumers branch on event name or just on `data`.
 */
export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Cap on the pending-line buffer. A malicious or buggy upstream that sends
 * megabytes without a newline could otherwise pin a worker via the prior
 * O(n²) CRLF replace + unbounded `buffer +=` pattern. 256 KB comfortably
 * accommodates any sane SSE event while ensuring we fail fast on garbage.
 */
const MAX_BUFFER_BYTES = 256 * 1024;

export async function* parseSSE(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
): AsyncIterable<SSEMessage> {
  if (!body) return;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event = 'message';
  const dataLines: string[] = [];

  const flush = (): SSEMessage | undefined => {
    if (dataLines.length === 0 && event === 'message') return undefined;
    const data = dataLines.join('\n');
    const msg: SSEMessage = { event, data };
    event = 'message';
    dataLines.length = 0;
    return msg;
  };

  const processLine = (line: string): SSEMessage | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined; // comment
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') event = value || 'message';
    else if (field === 'data') dataLines.push(value);
    // id / retry: ignored
    return undefined;
  };

  // Incremental CRLF normalization on each appended chunk only — previously
  // we ran `.replace(/\r\n/g, '\n')` on the *entire* buffer per chunk, which
  // is O(n²) in stream length. Trailing CR (split across chunks) is left
  // in the buffer; the splitter handles it on the next round.
  const appendChunk = (chunkStr: string): void => {
    if (chunkStr.length === 0) return;
    buffer += chunkStr;
    if (buffer.length > MAX_BUFFER_BYTES) {
      throw new Error(
        `SSE: pending line exceeds ${MAX_BUFFER_BYTES} bytes — upstream is not framing events`,
      );
    }
  };

  // Node.js Readable stream
  if (isNodeReadable(body)) {
    for await (const chunk of body as NodeJS.ReadableStream) {
      appendChunk(
        typeof chunk === 'string' ? chunk : decoder.decode(chunk as Buffer, { stream: true }),
      );
      const split = splitBuffer(buffer);
      buffer = split.tail;
      for (const line of split.lines) {
        const msg = processLine(line);
        if (msg) yield msg;
      }
    }
  } else {
    // Web ReadableStream
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        appendChunk(decoder.decode(value, { stream: true }));
        const split = splitBuffer(buffer);
        buffer = split.tail;
        for (const line of split.lines) {
          const msg = processLine(line);
          if (msg) yield msg;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  // Flush any trailing buffered line
  if (buffer.length > 0) {
    const msg = processLine(buffer.replace(/\r$/, ''));
    if (msg) yield msg;
  }
  const final = flush();
  if (final) yield final;
}

function splitBuffer(buf: string): { lines: string[]; tail: string } {
  // Split on \n directly; strip trailing \r per-line. Avoids the O(n²)
  // pattern of running .replace(/\r\n/g, '\n') on the entire buffer
  // every chunk.
  const parts = buf.split('\n');
  const tail = parts.pop() ?? '';
  const lines = parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  return { lines, tail };
}

function isNodeReadable(b: unknown): boolean {
  return (
    !!b &&
    typeof b === 'object' &&
    typeof (b as { pipe?: unknown }).pipe === 'function' &&
    typeof (b as { on?: unknown }).on === 'function'
  );
}
