import { spawn } from 'node:child_process';
import { buildChildEnv } from '../utils/child-env.js';
import type { HookInput, HookOutcome } from '../types/hooks.js';
import type { Logger } from '../types/logger.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Allowlist of safe shell commands for hooks. Commands not in this list are rejected.
// This prevents arbitrary command execution if a hook config file is compromised.
// For custom commands, operators should either:
//   1. Use absolute paths to trusted executables
//   2. Create wrapper scripts under .wrongstack/hooks/ and reference them by absolute path
const ALLOWED_SHELL_COMMANDS = new Set([
  // POSIX shells + Windows shells
  'bash', 'sh', 'dash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd',
  // Script interpreters — hooks are routinely small node/python scripts
  'node', 'deno', 'bun', 'npx', 'npm', 'pnpm', 'yarn',
  'python', 'python3', 'perl', 'ruby',
  // Utilities
  'echo', 'cat', 'grep', 'sed', 'awk', 'find', 'sort', 'uniq', 'wc', 'head', 'tail', 'cut',
  'tr', 'tee', 'xargs', 'printf', 'test', 'expr',
  // File operations
  'ls', 'stat', 'touch', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown',
  // Network (read-only)
  'curl', 'wget',
  // Git (common operations)
  'git', 'diff', 'merge',
  // Process
  'ps', 'kill', 'pgrep', 'pkill',
  // Text processing
  'jq', 'yq',
  // System info
  'uname', 'hostname', 'whoami', 'date',
]);

/** Absolute path on either platform (POSIX `/...` or Windows `C:\...` / `C:/...`). */
function isAbsoluteCommandPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function isCommandAllowed(command: string): boolean {
  // Extract the base command (first word) for allowlist check
  const baseCommand = command.trim().split(/\s+/)[0] ?? '';
  // Documented escape hatch #1: absolute paths reference operator-authored
  // trusted executables (incl. wrapper scripts under .wrongstack/hooks/) and
  // are allowed as-is — on both POSIX and Windows path syntax.
  if (isAbsoluteCommandPath(baseCommand)) return true;
  // Relative path with separators (e.g. ./scripts/hook.sh) — judge by filename.
  const commandName = /[\\/]/.test(baseCommand)
    ? baseCommand.split(/[\\/]/).pop() ?? baseCommand
    : baseCommand;

  return ALLOWED_SHELL_COMMANDS.has(commandName);
}

export interface ShellHookSpec {
  command: string;
  timeoutMs?: number | undefined;
}

/**
 * Run a shell hook (Claude-compatible). The `HookInput` JSON is written to the
 * command's stdin. Resolution rules, in order:
 *   - exit code 2 → `{ decision: 'block', reason: <stderr or stdout> }`
 *   - stdout parses as a JSON object → returned verbatim as a `HookOutcome`
 *   - otherwise → no-op (`null`)
 *
 * The hook never throws into the agent loop: spawn errors and timeouts resolve
 * to `null` and are logged. Output is capped at 64 KiB.
 */
export async function runShellHook(
  spec: ShellHookSpec,
  input: HookInput,
  logger?: Logger | undefined,
): Promise<HookOutcome | null> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Security: reject commands not in the allowlist
  if (!isCommandAllowed(spec.command)) {
    logger?.warn?.(`hook rejected: command not in allowlist: ${spec.command}`);
    return null;
  }

  return await new Promise<HookOutcome | null>((resolve) => {
    let settled = false;
    const done = (v: HookOutcome | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // `shell: true` runs the command line through the platform shell
      // (cmd.exe on Windows, /bin/sh on POSIX) with correct quoting — the
      // command is intentionally a user-authored shell string.
      child = spawn(spec.command, {
        cwd: input.cwd,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      logger?.warn?.(`hook spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return resolve(null);
    }

    const timer = setTimeout(() => {
      logger?.warn?.(`hook command timed out after ${timeoutMs}ms: ${spec.command}`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(null);
    }, timeoutMs);

    let out = '';
    let err = '';
    let outTrunc = false;
    child.stdout?.on('data', (d: Buffer) => {
      if (outTrunc) return;
      out += d.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES);
        outTrunc = true;
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < MAX_OUTPUT_BYTES) err += d.toString('utf8');
    });

    child.on('error', (e) => {
      logger?.warn?.(`hook command error: ${e instanceof Error ? e.message : String(e)}`);
      done(null);
    });

    child.on('close', (code) => {
      if (code === 2) {
        const reason = (err.trim() || out.trim() || 'blocked by hook').slice(0, 2_000);
        return done({ decision: 'block', reason });
      }
      const parsed = parseOutcome(out);
      done(parsed);
    });

    // Feed the payload and close stdin so the command isn't left waiting.
    try {
      child.stdin?.end(`${JSON.stringify(input)}\n`);
    } catch {
      /* the close/error handlers will resolve */
    }
  });
}

function parseOutcome(stdout: string): HookOutcome | null {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const outcome: HookOutcome = {};
    if (obj['decision'] === 'block' || obj['decision'] === 'allow') {
      outcome.decision = obj['decision'];
    }
    if (typeof obj['reason'] === 'string') outcome.reason = obj['reason'];
    if (typeof obj['additionalContext'] === 'string') {
      outcome.additionalContext = obj['additionalContext'];
    }
    if (obj['modifiedInput'] && typeof obj['modifiedInput'] === 'object') {
      outcome.modifiedInput = obj['modifiedInput'] as Record<string, unknown>;
    }
    return outcome;
  } catch {
    return null;
  }
}
