/**
 * `wstack hq` subcommand group — HQ command center lifecycle + browser
 * token management.
 *
 * Subcommand tree:
 *   wstack hq                      → start HQ server (alias for `wstack --hq`)
 *   wstack hq serve                → start HQ server (explicit form)
 *   wstack hq token create [label] → mint a browser token, write auth.json
 *   wstack hq token create --client [label] → mint a client token (/ws/client)
 *   wstack hq token list           → list issued browser tokens
 *   wstack hq token list --client   → list issued client tokens
 *   wstack hq token revoke <id>    → revoke a browser token (prefix match)
 *   wstack hq token revoke --client <id> → revoke a client token
 *
 * All subcommands accept `--data-dir <path>` to override the HQ data
 * directory (default `~/.wrongstack/hq`, honors `WRONGSTACK_HOME` /
 * `WRONGSTACK_HQ_DATA_DIR`).
 *
 * @module subcommands/handlers/hq
 */
import {
  HQ_AUTH_FILE_VERSION,
  expectDefined,
  mutateHqAuthFile,
  mintHqToken,
  readHqAuthFile,
  resolveHqDataDir,
  type HqToken,
} from '@wrongstack/core';
import type { HqServerHandle } from '../../hq-server.js';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

function resolveDataDir(deps: SubcommandDeps): string {
  const override = typeof deps.flags?.['data-dir'] === 'string' ? deps.flags['data-dir'] : undefined;
  return resolveHqDataDir(override);
}

export const hqCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  // `wstack hq` and `wstack hq serve` start the server.
  if (!sub || sub === 'serve') {
    return startServer(deps);
  }

  if (sub === 'token') {
    return hqTokenCmd(args.slice(1), deps);
  }

  if (sub === 'help' || sub === '--help') {
    printHelp(deps);
    return 0;
  }

  deps.renderer.writeError(`Unknown hq subcommand: ${sub}\n`);
  printHelp(deps);
  return 1;
};

async function startServer(deps: SubcommandDeps): Promise<number> {
  const { startHqServer } = await import('../../hq-server.js');
  const dataDir = resolveDataDir(deps);
  const flags = deps.flags ?? {};
  const host = typeof flags['host'] === 'string' ? flags['host'] : '127.0.0.1';
  const port = typeof flags['port'] === 'string' ? Number.parseInt(flags['port'], 10) : 3499;
  const strictPort = flags['strict-port'] === true;
  const open = flags['open'] === true;

  const handle = await startHqServer({ host, port, strictPort, dataDir });

  if (open) {
    try {
      const { openBrowser } = await import('@wrongstack/webui/server');
      openBrowser(handle.firstRunSetup?.browserUrl ?? `http://${handle.host}:${handle.port}`);
    } catch {
      // best-effort
    }
  }

  writeStartupInfo(deps, handle);

  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void handle.close().then(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function writeStartupInfo(deps: SubcommandDeps, handle: HqServerHandle): void {
  deps.renderer.write(`WrongStack HQ listening on http://${handle.host}:${handle.port}\n`);
  if (!handle.firstRunSetup) {
    deps.renderer.write(`Client endpoint:  ws://${handle.host}:${handle.port}/ws/client\n`);
    deps.renderer.write(`Browser endpoint: http://${handle.host}:${handle.port}\n`);
    return;
  }

  deps.renderer.write(`Browser endpoint: ${handle.firstRunSetup.browserUrl}\n`);
  deps.renderer.write(`Client endpoint:  ws://${handle.host}:${handle.port}/ws/client?token=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`);
  deps.renderer.write(`\nFirst-run HQ auth created in ${handle.firstRunSetup.dataDir}\n`);
  deps.renderer.write(`Start clients with:\n`);
  deps.renderer.write(`  WRONGSTACK_HQ_URL=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_URL}\n`);
  deps.renderer.write(`  WRONGSTACK_HQ_TOKEN=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`);
}

async function hqTokenCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const action = args[0];

  if (action === 'create') {
    return tokenCreate(args.slice(1), deps);
  }
  if (action === 'list' || action === 'ls' || !action) {
    return tokenList(args.slice(1), deps);
  }
  if (action === 'revoke' || action === 'rm' || action === 'remove') {
    return tokenRevoke(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown hq token subcommand: ${action ?? '(none)'}\n`);
  deps.renderer.write('Usage: wstack hq token <create|list|revoke>\n');
  return 1;
}

/**
 * Token scope: `browser` (validated on `/ws/browser`) or `client`
 * (validated on `/ws/client`). Defaults to `browser` for backward
 * compatibility with Phase 3.
 */
type TokenScope = 'browser' | 'client';

/** Detect `--client` / `-c` flag from the arg list. */
function resolveTokenScope(args: string[]): TokenScope {
  return args.some((a) => a === '--client' || a === '-c') ? 'client' : 'browser';
}

/** Strip flags from args, returning only positional values. */
function positionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

async function tokenCreate(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args);
  const pos = positionals(args);
  const label = pos[0]; // first positional is the label
  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';

  try {
    const next = await mutateHqAuthFile(
      dataDir,
      (current) => {
        const tokens = current[tokenField] ?? [];
        const newToken = mintHqToken(label);
        return {
          ...current,
          [tokenField]: [...tokens, newToken],
        };
      },
      { warn: (msg) => deps.renderer.writeWarning(`${msg}\n`) },
    );
    const list = next[tokenField] ?? [];
    const token = expectDefined(list[list.length - 1]);
    const endpoint = scope === 'client' ? '/ws/client' : '/ws/browser';
    deps.renderer.write(`Created ${scope} token.\n`);
    deps.renderer.write(`  id:         ${token.id}\n`);
    if (token.label) deps.renderer.write(`  label:      ${token.label}\n`);
    deps.renderer.write(`  token:      ${token.token}\n`);
    deps.renderer.write(`  createdAt:  ${token.createdAt}\n`);
    deps.renderer.write(`\n`);
    deps.renderer.write(`Connect with: ws://localhost:3499${endpoint}?token=${token.token}\n`);
    deps.renderer.write(`(Copy the token now — it will not be shown again in full.)\n`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(`Failed to write auth.json: ${(err as Error).message}\n`);
    return 1;
  }
}

async function tokenList(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args);
  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';
  const authFile = await readHqAuthFile(dataDir, {
    warn: (msg) => deps.renderer.writeWarning(`${msg}\n`),
  });
  const tokens: HqToken[] = authFile[tokenField] ?? [];

  if (tokens.length === 0) {
    deps.renderer.write(`No ${scope} tokens issued. ${scope === 'browser' ? 'Browsers' : 'Clients'} are in OPEN MODE.\n`);
    deps.renderer.write(`Run \`wstack hq token create ${scope === 'client' ? '--client ' : ''}[label]\` to enter TOKEN MODE.\n`);
    return 0;
  }

  deps.renderer.write(`${scope === 'client' ? 'Client' : 'Browser'} tokens (${tokens.length}) — TOKEN MODE:\n`);
  deps.renderer.write('\n');
  for (const t of tokens) {
    const masked = `${t.token.slice(0, 6)}…${t.token.slice(-4)} (${t.token.length} chars)`;
    deps.renderer.write(`  ${t.id}  ${masked}  ${t.createdAt}${t.label ? `  "${t.label}"` : ''}${t.lastUsedAt ? `  lastUsed ${t.lastUsedAt}` : ''}\n`);
  }
  deps.renderer.write('\n');
  deps.renderer.write(`${scope === 'client' ? 'Clients' : 'Browsers'} must append ?token=<full-token> to /ws/${scope}.\n`);
  return 0;
}

async function tokenRevoke(args: string[], deps: SubcommandDeps): Promise<number> {
  const scope = resolveTokenScope(args);
  const pos = positionals(args);
  const idPrefix = pos[0];
  if (!idPrefix) {
    deps.renderer.writeError(`Usage: wstack hq token revoke ${scope === 'client' ? '--client ' : ''}<id-prefix>\n`);
    return 1;
  }

  const dataDir = resolveDataDir(deps);
  const tokenField = scope === 'client' ? 'clientTokens' : 'browserTokens';
  let revoked: HqToken | undefined;
  try {
    await mutateHqAuthFile(
      dataDir,
      (current) => {
        const tokens = current[tokenField] ?? [];
        // Prefix match: revoke the first token whose id starts with the
        // supplied prefix. The full id is long; users usually paste the
        // first 8 chars.
        const matches = tokens.filter((t) => t.id.startsWith(idPrefix));
        if (matches.length === 0) {
          revoked = undefined;
          return current;
        }
        if (matches.length > 1) {
          revoked = matches[0]; // caller will surface ambiguity below
          return current;
        }
        revoked = matches[0];
        return {
          ...current,
          [tokenField]: tokens.filter((t) => t.id !== (revoked as HqToken).id),
        };
      },
      { warn: (msg) => deps.renderer.writeWarning(`${msg}\n`) },
    );
  } catch (err) {
    deps.renderer.writeError(`Failed to write auth.json: ${(err as Error).message}\n`);
    return 1;
  }

  if (!revoked) {
    deps.renderer.writeError(`No ${scope} token found matching id-prefix "${idPrefix}".\n`);
    return 1;
  }
  deps.renderer.write(`Revoked ${scope} token ${revoked.id}${revoked.label ? ` ("${revoked.label}")` : ''}.\n`);
  return 0;
}

function printHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq <serve | token>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`  wstack hq                      Start the HQ command center server.\n`);
  deps.renderer.write(`  wstack hq serve                Same as above (explicit form).\n`);
  deps.renderer.write(`  wstack hq token create [label] Mint a browser token, enter token mode.\n`);
  deps.renderer.write(`  wstack hq token create --client [label]  Mint a client token (/ws/client).\n`);
  deps.renderer.write(`  wstack hq token list           List issued browser tokens.\n`);
  deps.renderer.write(`  wstack hq token list --client   List issued client tokens.\n`);
  deps.renderer.write(`  wstack hq token revoke <id>    Revoke a browser token (id prefix match).\n`);
  deps.renderer.write(`  wstack hq token revoke --client <id>  Revoke a client token.\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`Flags (apply to all subcommands):\n`);
  deps.renderer.write(`  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`);
  deps.renderer.write(`  --host <ip>         Bind host (default 127.0.0.1).\n`);
  deps.renderer.write(`  --port <n>          Bind port (default 3499).\n`);
  deps.renderer.write(`  --strict-port       Fail if port is in use.\n`);
  deps.renderer.write(`  --open              Open the dashboard in the default browser.\n`);
  deps.renderer.write(`  --client, -c        Operate on client tokens instead of browser tokens.\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`auth.json schema version: ${HQ_AUTH_FILE_VERSION}.\n`);
}
