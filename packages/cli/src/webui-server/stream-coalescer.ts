/**
 * Server-side stream coalescing for the CLI WebUI bridge.
 *
 * Coalesces high-volume live events (provider text/thinking deltas, tool
 * progress) before they hit every connected browser tab. The frontend also
 * coalesces per animation frame, but without this layer long streams still
 * create one WebSocket message per provider token/tool progress event.
 *
 * PR 9 of Issue #30: extracted from `webui-server.ts`.
 */

const STREAM_COALESCE_MS = 16;
const STREAM_COALESCE_MAX_CHARS = 8 * 1024;

export interface StreamCoalescerDeps {
  /** Send a message to every connected client (webui-server's `broadcast`). */
  broadcast: (msg: { type: string; payload: unknown }) => void;
  /** Stamp a payload with the live session id (webui-server's `sessionPayload`). */
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
}

export interface ToolProgressPayload {
  sessionId?: string | undefined;
  id: string;
  name: string;
  event: { type?: string | undefined; text?: string | undefined };
}

export interface StreamCoalescer {
  queueTextDelta(text: string, sessionId?: string | undefined): void;
  queueThinkingDelta(text: string, sessionId?: string | undefined): void;
  queueToolProgress(payload: ToolProgressPayload): void;
  /** Flush a pending thinking buffer (text deltas interleave with thinking). */
  flushThinkingDelta(): void;
  /** Flush every pending buffer — call at iteration boundaries and shutdown. */
  flushAllStreamBuffers(): void;
}

export function createStreamCoalescer(deps: StreamCoalescerDeps): StreamCoalescer {
  const { broadcast, sessionPayload } = deps;

  let textDeltaBuffer = '';
  let textDeltaSessionId: string | undefined;
  let textDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingDeltaBuffer = '';
  let thinkingDeltaSessionId: string | undefined;
  let thinkingDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  const toolProgressBuffers = new Map<
    string,
    {
      sessionId?: string | undefined;
      id: string;
      name: string;
      eventType: string;
      text: string;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  const flushTextDelta = (): void => {
    if (textDeltaTimer) {
      clearTimeout(textDeltaTimer);
      textDeltaTimer = null;
    }
    if (!textDeltaBuffer) return;
    const text = textDeltaBuffer;
    const sessionId = textDeltaSessionId;
    textDeltaBuffer = '';
    textDeltaSessionId = undefined;
    broadcast({
      type: 'provider.text_delta',
      payload: sessionPayload({ sessionId, text, messageId: 'current' }),
    });
  };

  const flushThinkingDelta = (): void => {
    if (thinkingDeltaTimer) {
      clearTimeout(thinkingDeltaTimer);
      thinkingDeltaTimer = null;
    }
    if (!thinkingDeltaBuffer) return;
    const text = thinkingDeltaBuffer;
    const sessionId = thinkingDeltaSessionId;
    thinkingDeltaBuffer = '';
    thinkingDeltaSessionId = undefined;
    broadcast({
      type: 'provider.thinking_delta',
      payload: sessionPayload({ sessionId, text }),
    });
  };

  const queueTextDelta = (text: string, sessionId?: string | undefined): void => {
    if (!text) return;
    if (textDeltaBuffer && textDeltaSessionId !== sessionId) {
      flushTextDelta();
    }
    textDeltaSessionId = sessionId;
    textDeltaBuffer += text;
    if (textDeltaBuffer.length >= STREAM_COALESCE_MAX_CHARS) {
      flushTextDelta();
      return;
    }
    if (!textDeltaTimer) {
      textDeltaTimer = setTimeout(flushTextDelta, STREAM_COALESCE_MS);
      textDeltaTimer.unref?.();
    }
  };

  const queueThinkingDelta = (text: string, sessionId?: string | undefined): void => {
    if (!text) return;
    if (thinkingDeltaBuffer && thinkingDeltaSessionId !== sessionId) {
      flushThinkingDelta();
    }
    thinkingDeltaSessionId = sessionId;
    thinkingDeltaBuffer += text;
    if (thinkingDeltaBuffer.length >= STREAM_COALESCE_MAX_CHARS) {
      flushThinkingDelta();
      return;
    }
    if (!thinkingDeltaTimer) {
      thinkingDeltaTimer = setTimeout(flushThinkingDelta, STREAM_COALESCE_MS);
      thinkingDeltaTimer.unref?.();
    }
  };

  const flushToolProgress = (id: string): void => {
    const buffered = toolProgressBuffers.get(id);
    if (!buffered) return;
    if (buffered.timer) clearTimeout(buffered.timer);
    toolProgressBuffers.delete(id);
    if (!buffered.text) return;
    broadcast({
      type: 'tool.progress',
      payload: sessionPayload({
        sessionId: buffered.sessionId,
        name: buffered.name,
        id: buffered.id,
        event: { type: buffered.eventType, text: buffered.text },
      }),
    });
  };

  const flushAllStreamBuffers = (): void => {
    flushTextDelta();
    flushThinkingDelta();
    for (const id of [...toolProgressBuffers.keys()]) flushToolProgress(id);
  };

  const queueToolProgress = (payload: ToolProgressPayload): void => {
    const text = payload.event.text;
    if (!text) {
      flushToolProgress(payload.id);
      broadcast({
        type: 'tool.progress',
        payload: sessionPayload(payload as unknown as Record<string, unknown>),
      });
      return;
    }

    const eventType = payload.event.type ?? 'progress';
    const existing = toolProgressBuffers.get(payload.id);
    if (existing && existing.sessionId !== payload.sessionId) flushToolProgress(payload.id);
    if (existing && existing.eventType !== eventType) flushToolProgress(payload.id);
    const buffered = toolProgressBuffers.get(payload.id) ?? {
      sessionId: payload.sessionId,
      id: payload.id,
      name: payload.name,
      eventType,
      text: '',
      timer: null,
    };
    buffered.sessionId = payload.sessionId;
    buffered.name = payload.name;
    buffered.text += buffered.text ? `\n${text}` : text;
    toolProgressBuffers.set(payload.id, buffered);

    if (buffered.text.length >= STREAM_COALESCE_MAX_CHARS) {
      flushToolProgress(payload.id);
      return;
    }
    if (!buffered.timer) {
      buffered.timer = setTimeout(() => flushToolProgress(payload.id), STREAM_COALESCE_MS);
      buffered.timer.unref?.();
    }
  };

  return {
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
  };
}
