import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Agent, EventBus, ModelsRegistry, SessionWriter } from '@wrongstack/core';
import { type ProviderConfig, atomicWrite } from '@wrongstack/core';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core/security';
import { WebSocket, WebSocketServer } from 'ws';
import { maskedKey, normalizeKeys, nowIso, writeKeysBack } from './provider-config-utils.js';

// Re-export types from webui for type checking
// At runtime, the actual types are resolved via workspace resolution

// WSServerMessage and WSClientMessage types (mirrors packages/webui/src/types.ts)
export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown;
}

interface WebUIOptions {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  port?: number;
  modelsRegistry?: ModelsRegistry;
  globalConfigPath?: string;
  /**
   * Subscribe to live per-iteration events from the eternal-autonomy
   * engine. When provided, the WebUI broadcasts each iteration to every
   * connected client. Observability-only — starting the loop still goes
   * through REPL/TUI or the `--eternal` flag (the WebUI has no slash
   * command dispatch surface yet).
   */
  subscribeEternalIteration?: (
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void;
}

interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
}

export async function runWebUI(opts: WebUIOptions): Promise<void> {
  const port = opts.port ?? 3457;
  const clients = new Map<WebSocket, ConnectedClient>();
  let abortController: AbortController | null = null;

  // Generate a random auth token to prevent unauthorized local connections.
  // The WebUI frontend reads this from the session.start payload and uses it
  // for subsequent reconnections. Loopback connections are exempt for
  // convenience (matches standalone WebUI server behavior).
  const authToken = crypto.randomBytes(16).toString('hex');

  const wss = new WebSocketServer({ port, host: '127.0.0.1', maxPayload: 1 * 1024 * 1024 });

  console.log(`[WebUI] WebSocket server starting on ws://127.0.0.1:${port}`);
  // Auth token is sent to clients via the session.start payload — do NOT log it.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  function setupEvents() {
    // Clear any existing subscriptions
    for (const unsub of eventUnsubscribers) unsub();
    eventUnsubscribers.length = 0;

    // iteration.started
    eventUnsubscribers.push(
      opts.events.on('iteration.started', (e) => {
        broadcast({
          type: 'iteration.started',
          payload: { index: e.index },
        });
      }),
    );

    // provider.text_delta
    eventUnsubscribers.push(
      opts.events.on('provider.text_delta', (e) => {
        broadcast({
          type: 'provider.text_delta',
          payload: { text: e.text, messageId: 'current' },
        });
      }),
    );

    // provider.thinking_delta — extended-thinking deltas. The WebUI renders a
    // transient "Thinking…" chip from these; clears the moment text_delta /
    // tool.started / provider.response / run.result lands so the chip never
    // pollutes the persisted transcript.
    eventUnsubscribers.push(
      opts.events.on('provider.thinking_delta', (e) => {
        broadcast({
          type: 'provider.thinking_delta',
          payload: { text: e.text },
        });
      }),
    );

    // tool.started
    eventUnsubscribers.push(
      opts.events.on('tool.started', (e) => {
        broadcast({
          type: 'tool.started',
          payload: {
            id: e.id,
            name: e.name,
            input: e.input,
            messageId: `tool_${e.id}`,
          },
        });
      }),
    );

    // tool.progress
    eventUnsubscribers.push(
      opts.events.on('tool.progress', (e) => {
        broadcast({
          type: 'tool.progress',
          payload: {
            name: e.name,
            id: e.id,
            event: e.event,
          },
        });
      }),
    );

    // tool.executed
    eventUnsubscribers.push(
      opts.events.on('tool.executed', (e) => {
        broadcast({
          type: 'tool.executed',
          payload: {
            // Forward the tool_use id so the WebUI can correlate this with
            // the matching tool.started bubble for parallel tool calls.
            id: e.id,
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: e.input,
            output: e.output,
          },
        });
      }),
    );

    // provider.response
    eventUnsubscribers.push(
      opts.events.on('provider.response', (e) => {
        broadcast({
          type: 'provider.response',
          payload: {
            usage: e.usage,
            stopReason: e.stopReason,
            messageId: 'current',
          },
        });
      }),
    );

    // error
    eventUnsubscribers.push(
      opts.events.on('error', (e) => {
        broadcast({
          type: 'error',
          payload: {
            phase: e.phase,
            message: e.err instanceof Error ? e.err.message : String(e.err),
          },
        });
      }),
    );

    // eternal-autonomy iteration events. Each iteration the engine
    // completes lands here and is fanned out to every connected client
    // so the frontend can render a live timeline of the autonomous loop.
    // The unsubscribe is collected into eventUnsubscribers so a reconnect
    // or shutdown tears it down cleanly with the rest of the subscriptions.
    if (opts.subscribeEternalIteration) {
      eventUnsubscribers.push(
        opts.subscribeEternalIteration((entry) => {
          broadcast({
            type: 'eternal.iteration',
            payload: {
              iteration: entry.iteration,
              at: entry.at,
              source: entry.source,
              task: entry.task,
              status: entry.status,
              note: entry.note,
              tokens: entry.tokens,
              costUsd: entry.costUsd,
            },
          });
        }),
      );
    }
  }

  return new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://127.0.0.1:${port}`);
      setupEvents();
    });

    wss.on('connection', (ws, req) => {
      // --- Auth token + Origin validation ---
      // Loopback connections (from the WebUI frontend on localhost) are
      // allowed without a token for convenience. Non-loopback connections
      // require the token passed as ?token=<authToken>.
      const isLoopback = (hostname: string) =>
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

      // Constant-time token compare (length mismatch short-circuits).
      const tokenMatches = (provided: string | null): boolean => {
        if (!provided) return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(authToken);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      try {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const token = url.searchParams.get('token');
        const tokenOk = tokenMatches(token);

        // DNS-rebinding defense: the server is bound to loopback, so the Host
        // header of any legitimate client is a loopback name. A rebound
        // attacker page sends `Host: <attacker-domain>` even though the socket
        // peer is 127.0.0.1 — reject it.
        const hostHeader = (req.headers.host ?? '').trim();
        let hostOk = false;
        try {
          hostOk = !!hostHeader && isLoopback(new URL(`http://${hostHeader}`).hostname);
        } catch {
          hostOk = false;
        }
        if (!hostOk) {
          ws.close(4003, 'Forbidden: non-loopback Host header');
          return;
        }

        // Origin validation
        const origin = req.headers.origin;
        if (origin) {
          try {
            const { hostname } = new URL(origin);
            if (!isLoopback(hostname) && !tokenOk) {
              ws.close(4003, 'Forbidden: non-loopback origin requires auth token');
              return;
            }
          } catch {
            ws.close(4003, 'Forbidden: invalid origin');
            return;
          }
        } else {
          // Non-browser client (no origin header): require token for
          // defense-in-depth. Even though we bind to 127.0.0.1, a
          // compromised local process or DNS rebinding attack could
          // connect without an origin.
          if (!tokenOk) {
            ws.close(4003, 'Forbidden: auth token required for non-browser clients');
            return;
          }
        }
      } catch {
        ws.close(4001, 'Unauthorized: malformed request');
        return;
      }

      const client: ConnectedClient = { ws, sessionId: opts.session.id };
      clients.set(ws, client);
      console.log('[WebUI] Client connected');

      // Per-connection rate limiting: 60 messages per 60-second window.
      let msgCount = 0;
      let windowResetAt = Date.now() + 60_000;

      ws.on('message', async (data) => {
        const now = Date.now();
        if (now > windowResetAt) {
          msgCount = 0;
          windowResetAt = now + 60_000;
        }
        if (++msgCount > 60) {
          send(ws, {
            type: 'error',
            payload: { phase: 'rate_limit', message: 'Too many messages. Please wait.' },
          });
          return;
        }
        try {
          const msg = JSON.parse(data.toString()) as WSClientMessage;
          await handleMessage(ws, client, msg);
        } catch (err) {
          console.error('[WebUI] Failed to parse message', err);
        }
      });

      ws.on('close', () => {
        console.log('[WebUI] Client disconnected');
        clients.delete(ws);
      });

      // Send session.start to the new client (includes wsToken for reconnection)
      send(ws, {
        type: 'session.start',
        payload: {
          sessionId: opts.session.id,
          model: opts.agent.ctx.model,
          provider: (opts.agent.ctx.provider as { id: string }).id,
          wsToken: authToken,
        },
      });
    });

    wss.on('error', (err) => {
      console.error('[WebUI] Server error:', err);
    });

    // Graceful shutdown
    function shutdown() {
      console.log('[WebUI] Shutting down...');
      for (const unsub of eventUnsubscribers) unsub();
      for (const [ws] of clients) {
        ws.close();
      }
      clients.clear();
      wss.close(() => {
        console.log('[WebUI] Server stopped');
        resolve();
      });
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  async function handleMessage(
    ws: WebSocket,
    client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'user_message':
        await handleUserMessage(
          ws,
          client,
          (msg as { payload: { content: string } }).payload.content,
        );
        break;

      case 'abort':
        abortController?.abort();
        broadcast({
          type: 'error',
          payload: { phase: 'abort', message: 'User aborted' },
        });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'providers.list':
        await handleProvidersList(ws);
        break;

      case 'provider.models':
        await handleProviderModels(
          ws,
          (msg as { payload: { providerId: string } }).payload.providerId,
        );
        break;

      case 'providers.saved':
        await handleProvidersSaved(ws);
        break;

      case 'key.add':
      case 'key.update': {
        const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
        await handleKeyUpsert(ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
        break;
      }

      case 'key.delete': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeyDelete(ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'key.set_active': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeySetActive(ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'provider.add': {
        const m = msg as {
          payload: { id: string; family: string; baseUrl?: string; apiKey?: string };
        };
        await handleProviderAdd(ws, m.payload);
        break;
      }

      case 'provider.remove': {
        const m = msg as { payload: { providerId: string } };
        await handleProviderRemove(ws, m.payload.providerId);
        break;
      }
    }
  }

  async function handleUserMessage(
    ws: WebSocket,
    client: ConnectedClient,
    content: string,
  ): Promise<void> {
    // Guard against overlapping runs on the same Agent instance. Two
    // rapid user messages would otherwise start a second agent.run()
    // before the first one's cleanup settles, corrupting context state.
    if (abortController) {
      send(ws, {
        type: 'error',
        payload: { phase: 'agent.run', message: 'A run is already in progress. Abort it first.' },
      });
      return;
    }

    // Abort any existing run (safety net; the guard above makes this
    // unreachable in the overlapping case, but direct abort requests
    // from the client still need the controller reference).
    abortController = new AbortController();

    try {
      const result = await opts.agent.run(content, {
        signal: abortController.signal,
      });

      send(ws, {
        type: 'run.result',
        payload: {
          status: result.status,
          iterations: result.iterations,
          finalText: result.finalText,
          error: result.error
            ? {
                code: result.error.code,
                message: result.error.message,
                recoverable: result.error.recoverable,
              }
            : undefined,
        },
      });
    } catch (err) {
      send(ws, {
        type: 'error',
        payload: {
          phase: 'agent.run',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      abortController = null;
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Client disconnected between the readyState check and the send
          // — let the 'close' handler remove it from the map naturally.
        }
      }
    }
  }

  // ---- Provider/Model/Key management handlers ----

  async function handleProvidersList(ws: WebSocket): Promise<void> {
    if (!opts.modelsRegistry) {
      sendResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const providers = await opts.modelsRegistry.listProviders();
      const savedProviders = await loadSavedProviders();
      const savedIds = new Set(Object.keys(savedProviders));

      send(ws, {
        type: 'provider.catalog',
        payload: {
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            family: p.family,
            apiBase: p.apiBase,
            envVars: p.envVars,
            modelCount: p.models.length,
            hasApiKey: savedIds.has(p.id) || p.envVars.some((v) => !!process.env[v]),
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderModels(ws: WebSocket, providerId: string): Promise<void> {
    if (!opts.modelsRegistry) {
      sendResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const provider = await opts.modelsRegistry.getProvider(providerId);
      if (!provider) {
        sendResult(ws, false, `Provider "${providerId}" not found in catalog`);
        return;
      }
      send(ws, {
        type: 'provider.models',
        payload: {
          provider: providerId,
          models: provider.models.map((m) => ({
            id: m.id,
            name: m.name,
            releaseDate: m.release_date,
            contextWindow: m.limit?.context,
            inputCost: m.cost?.input,
            outputCost: m.cost?.output,
            capabilities: [
              ...(m.tool_call ? ['tools'] : []),
              ...(m.reasoning ? ['reasoning'] : []),
              ...(m.modalities?.input?.includes('image') ? ['vision'] : []),
              ...(m.open_weights ? ['open_weights'] : []),
            ],
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProvidersSaved(ws: WebSocket): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      send(ws, {
        type: 'providers.saved',
        payload: {
          providers: Object.entries(providers).map(([id, cfg]) => ({
            id,
            family: cfg.family,
            baseUrl: cfg.baseUrl,
            apiKeys: normalizeKeys(cfg).map((k) => ({
              label: k.label,
              maskedKey: maskedKey(k.apiKey),
              isActive: k.label === cfg.activeKey,
              createdAt: k.createdAt,
            })),
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId] ?? { type: providerId };
      const keys = normalizeKeys(existing);

      // Check if label exists
      const existingIdx = keys.findIndex((k) => k.label === label);
      if (existingIdx >= 0) {
        keys[existingIdx] = { ...keys[existingIdx]!, apiKey, createdAt: nowIso() };
      } else {
        keys.push({ label, apiKey, createdAt: nowIso() });
      }

      writeKeysBack(existing, keys);
      if (!existing.activeKey) existing.activeKey = label;
      providers[providerId] = existing;

      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" saved for ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      const keys = normalizeKeys(existing).filter((k) => k.label !== label);
      if (keys.length === 0) {
        delete providers[providerId];
      } else {
        writeKeysBack(existing, keys);
        if (existing.activeKey === label) {
          existing.activeKey = keys[0]!.label;
        }
        providers[providerId] = existing;
      }
      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" deleted from ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      existing.activeKey = label;
      writeKeysBack(existing, normalizeKeys(existing));
      providers[providerId] = existing;
      await saveProviders(providers);
      sendResult(ws, true, `Active key for ${providerId} set to "${label}"`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderAdd(
    ws: WebSocket,
    payload: { id: string; family: string; baseUrl?: string; apiKey?: string },
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (providers[payload.id]) {
        sendResult(ws, false, `Provider "${payload.id}" already exists. Use key.add to add a key.`);
        return;
      }
      const newProv: ProviderConfig = {
        type: payload.id,
        family: payload.family as ProviderConfig['family'],
        baseUrl: payload.baseUrl,
      };
      if (payload.apiKey) {
        newProv.apiKeys = [{ label: 'default', apiKey: payload.apiKey, createdAt: nowIso() }];
        newProv.activeKey = 'default';
      }
      providers[payload.id] = newProv;
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${payload.id}" added`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (!providers[providerId]) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      delete providers[providerId];
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${providerId}" removed`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Config I/O helpers (mirrors auth-menu.ts patterns) ----

  async function loadSavedProviders(): Promise<Record<string, ProviderConfig>> {
    if (!opts.globalConfigPath) return {};
    let raw: string;
    try {
      raw = await fs.readFile(opts.globalConfigPath, 'utf8');
    } catch {
      return {};
    }
    let parsed: { providers?: Record<string, ProviderConfig> } = {};
    try {
      parsed = JSON.parse(raw) as { providers?: Record<string, ProviderConfig> };
    } catch {
      return {};
    }
    if (!parsed.providers) return {};
    // Decrypt encrypted secret-bearing fields so callers operate on plaintext.
    const keyFile = path.join(path.dirname(opts.globalConfigPath), '.key');
    const vault = new DefaultSecretVault({ keyFile });
    return decryptConfigSecrets(parsed.providers, vault);
  }

  async function saveProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    if (!opts.globalConfigPath) return;
    let raw: string;
    let fileExists = true;
    try {
      raw = await fs.readFile(opts.globalConfigPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Permissions / IO error — refuse to overwrite blindly.
        throw new Error(
          `Refusing to mutate ${opts.globalConfigPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      fileExists = false;
      raw = '{}';
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // Refuse to clobber a corrupt-but-existing config (mirrors auth-menu.ts).
      if (fileExists) {
        throw new Error(
          `Refusing to overwrite corrupt config at ${opts.globalConfigPath} ` +
            `(${(err as Error).message}). Fix or move the file aside before retrying.`,
          { cause: err },
        );
      }
      parsed = {};
    }
    parsed.providers = providers;
    // Encrypt any plaintext secret-bearing fields before writing to disk.
    const keyFile = path.join(path.dirname(opts.globalConfigPath), '.key');
    const vault = new DefaultSecretVault({ keyFile });
    const encrypted = encryptConfigSecrets(parsed, vault);
    await atomicWrite(opts.globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  }

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }
} // end of runWebUI
