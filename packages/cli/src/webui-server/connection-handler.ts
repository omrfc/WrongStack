/**
 * WebSocket connection handler for the CLI WebUI bridge.
 *
 * One `wss.on('connection', ...)` per browser tab: per-socket error
 * handling (attached first, before any awaited work — an oversized inbound
 * frame or other socket-level error must never crash the process), auth via
 * the shared `verifyClient` policy, client registration (map entry + the
 * per-panel WS handlers), per-connection rate limiting, message dispatch,
 * close cleanup, and the initial `session.start` push.
 *
 * PR 14 of Issue #30: extracted from `webui-server.ts`.
 */
import type { IncomingMessage } from 'node:http';
import type {
  AutoPhaseWebSocketHandler,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  SpecsWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui/server';
import { verifyClient as verifyWsClient } from '@wrongstack/webui/server';
import type { WebSocket } from 'ws';
import { resolveAllPendingConfirms, type PendingConfirm } from './ws-handlers/index.js';
import type { WSClientMessage, WSServerMessage } from '../webui-server.js';

export interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
}

export interface ConnectionHandlerDeps {
  host: string;
  wsToken: string;
  requireToken: boolean;
  publicHostnames: string[];
  publicWsUrl: string | undefined;
  clients: Map<WebSocket, ConnectedClient>;
  currentSessionId: () => string;
  autoPhaseHandler: AutoPhaseWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
  /** 0 = disabled (default; this is a local, single-user tool). */
  rateLimitMax: number;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  handleMessage: (ws: WebSocket, client: ConnectedClient, msg: WSClientMessage) => Promise<void>;
  abortControllers: Map<WebSocket, AbortController>;
  pendingConfirms: Map<string, PendingConfirm>;
  buildSessionStartPayload: (
    overrides?: Record<string, unknown>,
    needsSetup?: boolean,
  ) => Promise<Record<string, unknown>>;
  needsSetup: boolean;
}

export function createConnectionHandler(
  deps: ConnectionHandlerDeps,
): (ws: WebSocket, req: IncomingMessage) => Promise<void> {
  return async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Per-connection error handler, attached FIRST (before any awaited
    // work or even the auth check). Without it, a socket-level error —
    // most notably an oversized inbound frame (the `ws` receiver throws
    // `RangeError: Max payload size exceeded`, close 1009, once a client
    // sends more than `maxPayload`) — is emitted as an unhandled 'error'
    // on this socket and crashes the whole process. `wss.on('error')`
    // only catches SERVER-level errors, not per-connection ones.
    ws.on('error', (err) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui_server.client_socket_error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });

    // --- Auth: DNS-rebinding guard + token (cookie or URL) + loopback
    // bootstrap. Delegated to the shared `verifyClient` (ws-auth.ts) so the
    // embedded server enforces the SAME policy as the standalone one — most
    // importantly the HttpOnly `ws_token` cookie set by `/ws-auth`, and a
    // SINGLE token (`wsToken`).
    //
    // This used to be an inline check that (a) validated `?token=` against a
    // SECOND, unrelated `authToken` (never the `wsToken` that lands in the
    // URL / cookie / `/api/*`), and (b) ignored the cookie entirely. On
    // loopback the origin bootstrap masked the mismatch, but the cookie path
    // was dead and a LAN bind (`WS_HOST=0.0.0.0`) could never authenticate.
    const ok = verifyWsClient({
      origin: req.headers.origin,
      url: req.url ?? '/',
      hostHeader: req.headers.host,
      remoteAddress: req.socket.remoteAddress,
      cookieHeader: req.headers.cookie,
      wsHost: deps.host,
      expectedToken: deps.wsToken,
      requireToken: deps.requireToken,
      allowedHostnames: deps.publicHostnames,
      allowBrowserUrlToken: Boolean(deps.publicWsUrl),
    });
    if (!ok) {
      ws.close(4003, 'Forbidden');
      return;
    }

    const client: ConnectedClient = { ws, sessionId: deps.currentSessionId() };
    deps.clients.set(ws, client);

    // Register this client with the AutoPhase handler so it receives phase events
    deps.autoPhaseHandler.addClient(ws);
    deps.specsHandler.addClient(ws);
    deps.sddBoardHandler.addClient(ws);
    deps.sddWizardHandler?.addClient(ws);
    deps.worktreeHandler.addClient(ws);

    // Per-connection rate limiting — disabled unless WEBUI_RATE_LIMIT > 0.
    let msgCount = 0;
    let windowResetAt = Date.now() + 60_000;

    ws.on('message', async (data) => {
      if (deps.rateLimitMax > 0) {
        const now = Date.now();
        if (now > windowResetAt) {
          msgCount = 0;
          windowResetAt = now + 60_000;
        }
        if (++msgCount > deps.rateLimitMax) {
          deps.send(ws, {
            type: 'error',
            payload: deps.sessionPayload({ phase: 'rate_limit', message: 'Too many messages. Please wait.' }),
          });
          return;
        }
      }
      try {
        const msg = JSON.parse(data.toString()) as WSClientMessage;
        await deps.handleMessage(ws, client, msg);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'webui_server.message_parse_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    });

    ws.on('close', () => {
      deps.clients.delete(ws);
      // Drop this socket's in-flight run controller (if any). We do NOT
      // abort the run here — a tab close may be a reload, and the user
      // may reconnect. The controller is removed so a future
      // `case 'abort'` from a reconnected socket starts clean. The
      // `handleUserMessage` finally-block also clears its entry, so
      // this is a safety net for an unclean close mid-run.
      deps.abortControllers.delete(ws);
      // If the last client leaves while a permission prompt is pending, deny
      // it so the agent loop doesn't hang waiting for an answer that will
      // never arrive (the terminal no longer prompts in --webui mode).
      if (deps.clients.size === 0 && deps.pendingConfirms.size > 0) {
        resolveAllPendingConfirms(deps.pendingConfirms, 'no');
      }
    });

    // Send session.start to the new client — per-model cost rates
    // and context-window cap so the frontend can compute accurate
    // live costs. The auth token is no longer in the payload: the
    // cookie path (`/ws-auth` → `Set-Cookie: ws_token=…`) is the
    // C-2 recommended delivery (Phase 1.4) and `?token=…` from
    // the server-printed URL is the back-compat fallback. Including
    // the token here would re-introduce the C-598 query-string
    // exposure class.
    const base = await deps.buildSessionStartPayload({}, deps.needsSetup);
    deps.send(ws, {
      type: 'session.start',
      payload: { ...base },
    });
  };
}
