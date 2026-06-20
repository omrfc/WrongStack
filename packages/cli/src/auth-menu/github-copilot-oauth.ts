/**
 * GitHub Copilot login — GitHub OAuth **device flow** (no loopback server).
 *
 *   1. POST github.com/login/device/code → user_code + verification_uri.
 *   2. User opens the URL, enters the code; we poll login/oauth/access_token
 *      until GitHub returns a long-lived OAuth token.
 *   3. Exchange that token at api.github.com/copilot_internal/v2/token for a
 *      short-lived Copilot token (the chat access token).
 *
 * Stored under the canonical `github-copilot` provider (family `github-copilot`,
 * an OpenAI chat/completions-compatible wire). The GitHub OAuth token is the
 * refresh token; the provider mints fresh Copilot tokens from it transparently.
 */

import { spawn } from 'node:child_process';
import { color, type ProviderApiKey, type ProviderConfig } from '@wrongstack/core';
import { copilotBaseUrlFromToken, refreshCopilotToken } from '@wrongstack/providers';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const COPILOT_API_VERSION = '2026-06-01';
export const COPILOT_PROVIDER_ID = 'github-copilot';

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

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
    /* best-effort */
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Start the GitHub device flow. */
export async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': COPILOT_HEADERS['User-Agent']!,
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub device-code request failed (${res.status})`);
  const json = (await res.json()) as Partial<DeviceCode> | null;
  if (
    !json?.device_code ||
    !json.user_code ||
    !json.verification_uri ||
    typeof json.expires_in !== 'number'
  ) {
    throw new Error('Invalid device-code response');
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    interval: json.interval ?? 5,
    expires_in: json.expires_in,
  };
}

/** Poll until the user authorizes; returns the GitHub OAuth token. */
export async function pollForGitHubToken(device: DeviceCode, signal: AbortSignal): Promise<string> {
  let intervalMs = device.interval * 1000;
  const expiresAt = Date.now() + device.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs, signal);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': COPILOT_HEADERS['User-Agent']!,
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (json.access_token) return json.access_token;
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`Device flow failed: ${json.error ?? 'unknown error'}`);
  }
  throw new Error('Device code expired — please restart the login.');
}

/** Fetch the user's selectable Copilot model ids (best-effort). */
async function fetchCopilotModels(copilotToken: string, signal: AbortSignal): Promise<string[]> {
  try {
    const base = copilotBaseUrlFromToken(copilotToken);
    const res = await fetch(`${base}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${copilotToken}`,
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
        ...COPILOT_HEADERS,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> } | null;
    const data = json?.data;
    if (!Array.isArray(data)) return [];
    const ids: string[] = [];
    for (const item of data) {
      const id = item['id'];
      const policy = item['policy'] as { state?: string } | undefined;
      if (
        typeof id === 'string' &&
        item['model_picker_enabled'] === true &&
        policy?.state !== 'disabled'
      ) {
        ids.push(id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

export interface CopilotLoginOptions {
  providerId?: string;
}

export async function runCopilotOAuthLogin(
  deps: AuthMenuDeps,
  opts: CopilotLoginOptions = {},
): Promise<number> {
  const providerId = opts.providerId ?? COPILOT_PROVIDER_ID;
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);

  try {
    deps.renderer.write(
      color.bold(`\n  Sign in with GitHub Copilot — ${color.cyan(providerId)}\n`) +
        color.dim('  Uses your GitHub Copilot subscription (not an API key).\n') +
        color.amber('  ⚠ Using Copilot outside its official editor integrations may violate\n') +
        color.amber('    GitHub’s Terms — your account could be rate-limited or banned.\n\n'),
    );

    const device = await startDeviceFlow(ac.signal);
    deps.renderer.write(
      color.bold(`  ${'─'.repeat(56)}\n`) +
        color.bold('  Open this URL and enter the code:\n') +
        color.cyan(`  ${device.verification_uri}\n`) +
        color.bold('  Code: ') +
        color.green(color.bold(device.user_code)) +
        '\n' +
        color.bold(`  ${'─'.repeat(56)}\n\n`),
    );
    openBrowser(device.verification_uri);
    deps.renderer.write(color.dim('  Waiting for you to authorize in the browser...\n'));

    const githubToken = await pollForGitHubToken(device, ac.signal);
    deps.renderer.write(color.dim('  Authorized. Fetching your Copilot token...\n'));
    const copilot = await refreshCopilotToken(githubToken, ac.signal);
    const models = await fetchCopilotModels(copilot.token, ac.signal);

    const saved = await saveCopilotTokens(
      deps,
      providerId,
      copilot.token,
      githubToken,
      copilot.expires,
      models,
    );
    if (!saved) return 1;

    deps.renderer.write(color.green('\n  ✓ Signed in with GitHub Copilot!\n'));
    const modelHint = models[0] ?? 'gpt-4o';
    deps.renderer.writeInfo(
      `  Saved as provider ${color.bold(providerId)}${models.length ? ` (${models.length} models)` : ''}.\n` +
        `  Use: ${color.bold(`wstack --provider ${providerId} --model ${modelHint}`)} "<task>"\n` +
        color.dim('  The Copilot token refreshes automatically.\n'),
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
    process.off('SIGINT', onSig);
  }
}

async function saveCopilotTokens(
  deps: AuthMenuDeps,
  providerId: string,
  copilotToken: string,
  githubToken: string,
  expires: number,
  models: string[],
): Promise<boolean> {
  const entry: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: copilotToken,
    createdAt: nowIso(),
    authMethod: 'oauth',
    expiresAt: new Date(expires).toISOString(),
    refreshToken: githubToken,
    tokenType: 'bearer',
  };
  try {
    await mutateConfigProviders(deps.globalConfigPath, deps.vault, (all) => {
      const existing = all[providerId];
      const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
      p.family = 'github-copilot';
      if (!p.baseUrl) p.baseUrl = copilotBaseUrlFromToken(copilotToken);
      if (models.length > 0) p.models = models;
      else if (!p.models || p.models.length === 0) p.models = ['gpt-4o'];
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
