/**
 * OpenAI Codex — "Sign in with ChatGPT" OAuth (Authorization Code + PKCE).
 *
 * This is the ONLY login flow that actually works for using a ChatGPT
 * Plus/Pro/Team subscription programmatically. It mirrors the real Codex CLI:
 *
 *   1. Generate a PKCE verifier/challenge (S256) + CSRF state.
 *   2. Start a loopback HTTP server on http://localhost:1455/auth/callback.
 *   3. Open the browser to https://auth.openai.com/oauth/authorize.
 *   4. The browser redirects back to the loopback with `?code=...&state=...`.
 *   5. Exchange the code at https://auth.openai.com/oauth/token for an
 *      access_token + refresh_token (and an id_token carrying the account id).
 *   6. Store the tokens in the vault as an `oauth` ProviderApiKey.
 *
 * The resulting access token is a JWT whose `https://api.openai.com/auth`
 * claim contains `chatgpt_account_id`. Requests then go to the ChatGPT
 * backend (`chatgpt.com/backend-api/codex/responses`) — NOT api.openai.com —
 * which is what the `openai-codex` wire family handles. The standard
 * API-key flow (`family: openai` → api.openai.com/chat/completions) is left
 * completely untouched.
 *
 * NOTE: a ChatGPT web *session cookie* is NOT an API token. The old
 * device-code + cookie-scraping attempts could never produce a usable
 * credential; this module replaces them.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  color,
  type ModelsRegistry,
  type ProviderApiKey,
  type ProviderConfig,
} from '@wrongstack/core';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

// ── Codex OAuth constants (verified against the real Codex CLI) ─────────────

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_PORT = 1455;
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPE = 'openid profile email offline_access';
/** JWT claim that carries the ChatGPT account id. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
/** Telemetry/branding tag sent to authorize + as a request header. Free-form. */
const ORIGINATOR = 'wrongstack';
/** Canonical provider id under which ChatGPT-login credentials are stored. */
export const CODEX_PROVIDER_ID = 'openai-codex';
/** Default ChatGPT backend base. The wire family appends `/codex/responses`. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

/**
 * Fallback model list used when BOTH the live backend AND the models.dev
 * catalog are unreachable. This should never happen in practice — the
 * catalog is cached locally and the only scenario where both fail is a
 * fresh install with no network on first login.
 *
 * The primary resolution order in `resolveCodexModels()` is:
 *  1. Live backend (`GET /models`)
 *  2. models.dev catalog (`family: gpt-codex*` under `openai` provider)
 *  3. This inline fallback
 */
// ── Token shapes ────────────────────────────────────────────────────────────

export interface CodexTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString('hex');
}

/** Build the full authorize URL with all Codex-required query params. */
export function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', ORIGINATOR);
  return url.toString();
}

// ── JWT account-id extraction ───────────────────────────────────────────────

interface JwtAuthClaim {
  chatgpt_account_id?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract `chatgpt_account_id` from an access/id token JWT. Returns null when
 * the token isn't a JWT or lacks the claim (the caller decides whether that
 * is fatal — for login it is; for a cached display value it isn't).
 */
export function extractAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = payload?.[JWT_CLAIM_PATH] as JwtAuthClaim | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// ── Model discovery ──────────────────────────────────────────────────────────

/**
 * Recommended Codex models for ChatGPT sign-in. Live backend discovery
 * wins; these values are only used when the backend/catalog cannot
 * provide a list. Single source of truth — used both by OAuth login
 * (resolveCodexModels → tier 3) and by the provider-boot synthesis
 * path (wiring/provider.ts when the catalog is unavailable).
 */
export const FALLBACK_CODEX_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'gpt-5.5', name: 'gpt-5.5' },
  { id: 'gpt-5.4', name: 'gpt-5.4' },
  { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini' },
  { id: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark' },
];

/** Families in the models.dev catalog that indicate Codex / Responses API compatibility. */
export const CODEX_CATALOG_FAMILIES = new Set(['gpt-codex', 'gpt-codex-spark']);

export function fallbackCodexModelIds(): string[] {
  return FALLBACK_CODEX_MODELS.map((m) => m.id);
}

export function fallbackCodexProviderModels(): Array<{ id: string; name: string }> {
  return FALLBACK_CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Filter a list of available model ids down to the ones that are still
 * current for ChatGPT sign-in (i.e. present in FALLBACK_CODEX_MODELS).
 * Used by both OAuth login (to drop deprecated ids from the live /models
 * response) and by the provider-boot synthesis (to pick current ids out
 * of the models.dev catalog).
 */
export function filterCurrentCodexModelIds(ids: Iterable<string>): string[] {
  const available = new Set(ids);
  return FALLBACK_CODEX_MODELS.map((m) => m.id).filter((id) => available.has(id));
}

export function isCodexCatalogModel(model: { family?: string | undefined }): boolean {
  return typeof model.family === 'string' && CODEX_CATALOG_FAMILIES.has(model.family);
}

/**
 * Resolve the list of available Codex models using a 3-tier fallback chain:
 *
 *  1. **Live backend** — `fetchCodexModels()` hits `GET <baseUrl>/models`
 *     and keeps only current Codex model ids.
 *  2. **models.dev catalog** — queries the `openai` provider in the cached
 *     models.dev registry and picks models whose `family` is `gpt-codex` or
 *     `gpt-codex-spark` and whose ids are current for ChatGPT sign-in.
 *  3. **Inline fallback** — a minimal list of documented mainstream models
 *     (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`).
 *
 * The live/catalog tiers gate account availability, while the shared current
 * model list filters out deprecated ChatGPT sign-in ids before config is saved.
 */
export async function resolveCodexModels(
  modelsRegistry: ModelsRegistry,
  accessToken: Promise<string> | string,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  // Tier 1 — live backend
  const token = typeof accessToken === 'string' ? accessToken : await accessToken;
  const live = filterCurrentCodexModelIds(await fetchCodexModels(token, baseUrl, signal));
  if (live.length > 0) return live;

  // Tier 2 — models.dev catalog
  try {
    const openaiProvider = await modelsRegistry.getProvider('openai');
    if (openaiProvider) {
      const catalog = openaiProvider.models
        .filter(isCodexCatalogModel)
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const currentCatalog = filterCurrentCodexModelIds(catalog);
      if (currentCatalog.length > 0) return currentCatalog;
    }
  } catch {
    // catalog unavailable — fall through to tier 3
  }

  // Tier 3 — inline fallback
  return fallbackCodexModelIds();
}

/**
 * Fetch the account's available Codex model ids live from the ChatGPT backend.
 *
 * Hits `GET <baseUrl>/models` — the standard OpenAI-compatible model listing
 * endpoint, which the Codex backend may expose. Best-effort: returns an empty
 * array on any failure so login still succeeds with the hardcoded fallback.
 */
export async function fetchCodexModels(
  accessToken: string,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${(baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        originator: 'wrongstack',
        'OpenAI-Beta': 'responses=experimental',
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as
      | { data?: Array<{ id?: string }> }
      | { models?: Array<{ id?: string }> }
      | null;
    if (!json) return [];
    // Standard OpenAI-compatible: { data: [{ id: "gpt-...", ... }] }
    const rawList: unknown[] =
      'data' in json && Array.isArray(json.data)
        ? (json.data as unknown[])
        : 'models' in json && Array.isArray(json.models)
          ? (json.models as unknown[])
          : [];
    const ids: string[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

// ── Token endpoint calls ────────────────────────────────────────────────────

async function readTokens(res: Response, op: string): Promise<CodexTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token ${op} failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as TokenEndpointResponse | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`Codex token ${op} response missing fields`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return readTokens(res, 'exchange');
}

/**
 * Refresh an expired access token using the stored refresh token. Exported for
 * the `openai-codex` provider, which calls it transparently before requests.
 */
export async function refreshCodexToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return readTokens(res, 'refresh');
}

// ── Loopback callback server ────────────────────────────────────────────────

function callbackHtml(ok: boolean, message: string): string {
  const heading = ok ? 'Authentication successful' : 'Authentication failed';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<title>${heading}</title><style>body{margin:0;min-height:100vh;display:flex;` +
    `align-items:center;justify-content:center;background:#09090b;color:#fafafa;` +
    `font-family:ui-sans-serif,system-ui,sans-serif;text-align:center}` +
    `h1{font-size:26px;margin:0 0 8px}p{color:#a1a1aa}</style></head><body><main>` +
    `<h1>${heading}</h1><p>${message}</p></main></body></html>`
  );
}

interface LoopbackServer {
  /** Resolves with the authorization code, or null if cancelled/failed to bind. */
  waitForCode(): Promise<string | null>;
  close(): void;
  /** True when the server bound to the port; false means the port was busy. */
  readonly bound: boolean;
}

/**
 * Start the loopback server. Resolves once it is listening (or has failed to
 * bind, in which case `bound` is false and the caller falls back to manual
 * paste).
 */
function startLoopbackServer(state: string): Promise<LoopbackServer> {
  let resolveCode: (v: string | null) => void = () => {};
  const codePromise = new Promise<string | null>((resolve) => {
    let settled = false;
    resolveCode = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
  });

  const server: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${REDIRECT_HOST}`);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname !== REDIRECT_PATH) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(callbackHtml(false, 'Callback route not found.'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.end(callbackHtml(false, `Authorization error: ${err}`));
      resolveCode(null);
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'State mismatch — please restart the login.'));
      resolveCode(null);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'Missing authorization code.'));
      return;
    }
    res.statusCode = 200;
    res.end(callbackHtml(true, 'You can close this window and return to the terminal.'));
    resolveCode(code);
  });

  return new Promise<LoopbackServer>((resolve) => {
    server.on('error', () => {
      // Port busy / cannot bind — signal manual fallback.
      resolveCode(null);
      resolve({
        bound: false,
        waitForCode: () => Promise.resolve(null),
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      resolve({
        bound: true,
        waitForCode: () => codePromise,
        close: () => {
          resolveCode(null);
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

// ── Browser opener (best-effort, windowsHide; never throws) ─────────────────

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const { command, args } =
      platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : platform === 'darwin'
          ? { command: 'open', args: [url] }
          : { command: 'xdg-open', args: [url] };
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // URL is always printed — best-effort only.
  }
}

// ── Manual paste fallback ───────────────────────────────────────────────────

/** Parse a pasted authorization code or full redirect URL into { code, state }. */
export function parseAuthorizationInput(input: string): {
  code?: string | undefined;
  state?: string | undefined;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}

// ── Main login flow ─────────────────────────────────────────────────────────

export interface CodexLoginOptions {
  /** Storage provider id. Defaults to the canonical `openai-codex`. */
  providerId?: string;
}

/**
 * Run the "Sign in with ChatGPT" flow and persist the resulting OAuth tokens.
 * Returns 0 on success, 1 on cancel/error.
 */
export async function runCodexOAuthLogin(
  deps: AuthMenuDeps,
  opts: CodexLoginOptions = {},
): Promise<number> {
  const providerId = opts.providerId ?? CODEX_PROVIDER_ID;
  const pkce = generatePkce();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl(pkce.challenge, state);

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);

  const server = await startLoopbackServer(state);

  deps.renderer.write(
    color.bold(`\n  Sign in with ChatGPT — ${color.cyan(providerId)}\n`) +
      color.dim('  Uses your ChatGPT Plus/Pro/Team subscription (not an API key).\n') +
      color.amber('  ⚠ Using a subscription outside the official Codex client may violate\n') +
      color.amber('    OpenAI’s Terms — your account could be rate-limited or banned.\n') +
      color.dim('    Sanctioned programmatic use = an API key: ') +
      color.bold('wstack auth openai') +
      color.dim('\n\n') +
      color.bold(`  ${'─'.repeat(56)}\n`) +
      color.bold('  Open this URL in your browser to sign in:\n') +
      color.cyan(`  ${authorizeUrl}\n`) +
      color.bold(`  ${'─'.repeat(56)}\n\n`),
  );

  if (server.bound) {
    openBrowser(authorizeUrl);
    deps.renderer.write(
      color.dim('  A browser window should open. Waiting for you to finish signing in...\n') +
        color.dim('  (Listening on http://localhost:1455 — press Ctrl+C to cancel.)\n'),
    );
  } else {
    deps.renderer.write(
      color.amber('  ⚠ Could not start the local callback listener (port 1455 in use).\n') +
        color.dim('  After signing in, copy the full redirect URL from your browser\n') +
        color.dim('  (it starts with http://localhost:1455/auth/callback) and paste it below.\n'),
    );
  }

  let code: string | undefined;
  try {
    if (server.bound) {
      const got = await server.waitForCode();
      if (got) code = got;
    }

    // Manual paste fallback (port busy, or browser couldn't redirect back).
    if (!code) {
      const input = (
        await deps.reader.readLine(
          `\n  ${color.amber('?')} Paste the redirect URL or code ${color.dim('(or q to cancel)')}: `,
        )
      ).trim();
      if (input.toLowerCase() === 'q' || input === '') {
        deps.renderer.write(color.dim('  Cancelled.\n'));
        return 1;
      }
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        deps.renderer.writeError('  State mismatch — please restart the login flow.');
        return 1;
      }
      code = parsed.code;
    }

    if (!code) {
      deps.renderer.writeError('  No authorization code received.');
      return 1;
    }

    deps.renderer.write(color.dim('\n  Exchanging authorization code for tokens...\n'));
    const tokens = await exchangeAuthorizationCode(code, pkce.verifier, ac.signal);
    const accountId = extractAccountId(tokens.access);
    if (!accountId) {
      deps.renderer.writeError(
        '  Signed in, but the token has no ChatGPT account id.\n' +
          '  This account may not have Codex/ChatGPT subscription access.',
      );
      return 1;
    }

    // Fetch available models from the Codex backend (best-effort).
    deps.renderer.write(color.dim('  Fetching available models...\n'));
    const models = await resolveCodexModels(
      deps.modelsRegistry,
      tokens.access,
      CODEX_BASE_URL,
      ac.signal,
    );

    const saved = await saveCodexTokens(deps, providerId, tokens, accountId, models);
    if (!saved) return 1;

    const modelHint = models[0] ?? 'gpt-5.5';
    deps.renderer.write(color.green('\n  ✓ Signed in with ChatGPT!\n'));
    deps.renderer.writeInfo(
      `  Saved as provider ${color.bold(providerId)}${models.length > 0 ? ` (${models.length} models)` : ''}.\n` +
        `  Use: ${color.bold(`wstack --provider ${providerId} --model ${modelHint}`)} "<task>"\n` +
        color.dim('  Tokens refresh automatically before they expire.\n'),
    );
    return 0;
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'Login cancelled.'
        : (err as Error).message;
    deps.renderer.writeError(`  Login failed: ${msg}`);
    return 1;
  } finally {
    server.close();
    process.off('SIGINT', onSig);
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function saveCodexTokens(
  deps: AuthMenuDeps,
  providerId: string,
  tokens: CodexTokens,
  accountId: string,
  models: string[],
): Promise<boolean> {
  const entry: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: tokens.access,
    createdAt: nowIso(),
    authMethod: 'oauth',
    expiresAt: new Date(tokens.expires).toISOString(),
    refreshToken: tokens.refresh,
    tokenType: 'bearer',
    scope: SCOPE,
    accountId,
  };

  try {
    await mutateConfigProviders(deps.globalConfigPath, deps.vault, (all) => {
      const existing = all[providerId];
      const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
      p.family = 'openai-codex';
      if (!p.baseUrl) p.baseUrl = CODEX_BASE_URL;
      // The caller populates `models` from the live backend or the fallback
      // constant. Always overwrite — the backend is authoritative.
      p.models = [...models];

      const keys = normalizeKeys(p).filter((k) => k.label !== entry.label);
      keys.push(entry);
      writeKeysBack(p, keys);
      p.activeKey = entry.label;
      all[providerId] = p;
    });
    return true;
  } catch (err) {
    deps.renderer.writeError(`  Failed to save tokens: ${(err as Error).message}`);
    return false;
  }
}
