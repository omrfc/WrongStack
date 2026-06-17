import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { COMMAND_OUTPUT_MAX_BYTES, normalizeCommandOutput } from './_util.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';
import { resolveWin32Command } from './_win32-resolve.js';

const isWin = process.platform === 'win32';

const ALLOWED_COMMANDS: Record<string, string[]> = {
  node: ['--version', '-r', '--input-type=module'],
  npm: ['--version', 'list', 'pkg', 'doctor', 'view', 'outdated', 'audit'],
  pnpm: ['--version', 'remove', 'list', 'view', 'outdated', 'audit'],
  npx: ['--version'],
  git: [
    '--version',
    'status',
    'log',
    'diff',
    'branch',
    'checkout',
    'stash',
    'add',
    'commit',
    'push',
    'pull',
  ],
  ls: ['-la', '-l', '-a'],
  cat: [],
  head: ['-n'],
  tail: ['-n'],
  wc: ['-l', '-w', '-c'],
  grep: [],
  find: [],
  echo: [],
  mkdir: ['-p'],
  cp: ['-r'],
  mv: [],
  rm: ['-rf'],
  touch: [],
  bun: ['--version'],
  tsc: ['--version', '--noEmit', '--project'],
  vitest: ['--version', 'run', '--coverage'],
  biome: ['--version', 'lint', 'format', 'check'],
  cargo: ['--version', 'build', 'test', 'check'],
  rustc: ['--version'],
  go: ['version', 'run', 'build', 'test'],
  python: ['--version'],
  pip: ['--version', 'list'],
  docker: ['--version', 'ps', 'images'],
  kubectl: ['version', 'get', 'describe', 'logs'],
};

const MAX_ARGS = 20;
// 200 KB — larger than bash's 32 KB cap. exec commands produce structured,
// predictable output (build logs, test results, git diffs) that the agent
// needs in full. 200 KB is safe for context windows ≥200K tokens while
// still preventing a rogue build from filling the context.
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// Per-command argument validation. Each entry is a list of regex patterns
// that, if matched against any argument, will reject the invocation.
// This blocks common injection vectors through allowlisted commands.
const BLOCKED_ARG_PATTERNS: Record<string, RegExp[]> = {
  // python -c/--command executes arbitrary code; python -m runs modules
  python: [/-c$/, /^--command$/, /^-m$/, /^--module$/],
  // git --exec=<cmd> runs arbitrary commands via upload-pack/receive-pack;
  // -C <dir> changes working directory, bypassing cwd sandbox;
  // -c/--config <k>=<v> injects config that runs commands
  // (e.g. core.sshCommand, core.pager, http.proxy, alias.x=!cmd).
  git: [
    /^--exec=/,
    /^--upload-pack=/,
    /^--receive-pack=/,
    /^-C$/,
    /^-c$/,
    /^--config$/,
    /^-c=/,
    /^--config=/,
    /^--config-env=/,
  ],
  // node -r/--require preloads arbitrary modules; --eval executes code
  node: [/^-r$/, /^--require$/, /^-e$/, /^--eval$/, /^--prof-process$/],
  // go run could execute arbitrary .go files; -ldflags could inject build-time code
  go: [/^-ldflags$/],
  // bun --preload is similar to node --require
  bun: [/^--preload$/, /^run$/, /^bunx$/, /^create$/, /^init$/],
  // docker build/run can create containers with host access;
  // only allow read-only commands (ps, images, version)
  docker: [/^build$/, /^run$/, /^exec$/, /^push$/, /^pull$/],
  // find -exec/-ok/-execdir execute arbitrary commands
  find: [/^-exec$/, /^-exec;$/, /^-ok$/, /^-ok;$/, /^-execdir$/, /^-execdir;$/, /^-exec=/, /^-ok=/, /^-execdir=/],
  // rm -rf / is catastrophic — block absolute paths, home, dot-dirs,
  // and glob patterns that could expand to dangerous targets.
  // `rm -rf ./src/*` expands to project files; `rm -rf ../../` escapes upward;
  // `rm -rf /*` targets the filesystem root. All are blocked.
  rm: [/^\//, /^~\//, /^~$/, /^\.$/, /^\.\.$/, /\*$/, /\/$/, /\/\*$/, /\.\//],
  // npm run/exec/create/pack/publish can execute arbitrary scripts or publish malware
  npm: [/^run$/, /^exec$/, /^create$/, /^init$/, /^pack$/, /^publish$/, /^deploy$/],
  // pnpm run/dlx/exec/create can execute arbitrary scripts
  pnpm: [/^run$/, /^dlx$/, /^exec$/, /^create$/, /^init$/, /^pack$/, /^publish$/, /^deploy$/],
  // npx should only be used for --version; any package name is a vector for
  // malicious package execution (typosquatting, dependency confusion)
  npx: [/^[^\s]+$/],
};

function validateArgs(cmd: string, args: string[]): string | null {
  const blocked = BLOCKED_ARG_PATTERNS[cmd];
  if (!blocked) return null;

  for (const arg of args) {
    for (const pattern of blocked) {
      if (pattern.test(arg)) {
        return `Blocked argument "${arg}" for command "${cmd}" (matches security pattern ${pattern})`;
      }
    }
  }
  return null;
}

interface ExecInput {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  timeout?: number | undefined;
}

interface ExecOutput {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  allowed: boolean;
}

export const execTool: Tool<ExecInput, ExecOutput> = {
  name: 'exec',
  category: 'Shell',
  description:
    'Execute a **whitelisted, restricted set of commands** with strict argument validation. ' +
    'This is the **preferred and safer** alternative to the `bash` tool for running development tools (node, npm, pnpm, tsc, git, tests, linters, etc.). ' +
    'It prevents arbitrary command injection and limits what the model can do.',
  usageHint:
    'PREFERRED SHELL TOOL for most cases.\n\n' +
    'Use this instead of `bash` whenever possible.\n' +
    '- `command` must be one of the allowed commands (node, npm, pnpm, git, tsc, eslint, vitest, etc.).\n' +
    '- Arguments are passed as a clean array (no shell interpretation).\n' +
    '- `cwd` is validated to stay inside the project.\n' +
    '- For anything that requires real shell features (pipes, complex redirection, arbitrary commands), fall back to `bash` (with strong justification).\n' +
    'This tool significantly reduces the risk compared to full shell access.',
  permission: 'confirm',
  mutating: true,
  riskTier: 'standard',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  capabilities: ['shell.restricted'],
  icon: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The base command to run. Must be in the internal allowlist (e.g. "node", "pnpm", "git", "tsc").',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed to the command. Passed as an array (no shell parsing).',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Must resolve inside the project root.',
      },
      timeout: {
        type: 'integer',
        description: 'Per-command timeout in milliseconds.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    const registry = getProcessRegistry();
    if (!registry.canProceed) {
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: '',
        stderr: 'Circuit breaker is open — too many consecutive failures. Use /kill reset to recover.',
        exitCode: 1,
        truncated: false,
        allowed: false,
      };
    }

    const cmd = input.command.trim();
    if (!cmd)
      return {
        command: cmd,
        args: [],
        stdout: '',
        stderr: 'Empty command',
        exitCode: 1,
        truncated: false,
        allowed: false,
      };

    if (!(cmd in ALLOWED_COMMANDS)) {
      return {
        command: cmd,
        args: input.args ?? [],
        stdout: '',
        stderr: `Command "${cmd}" not in allowlist. Use the bash tool for arbitrary commands.`,
        exitCode: 1,
        truncated: false,
        allowed: false,
      };
    }

    const args = (input.args ?? []).slice(0, MAX_ARGS);
    const timeout = Math.max(1, Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));

    // Validate args against per-command security patterns
    const argError = validateArgs(cmd, args);
    if (argError) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: argError,
        exitCode: 1,
        truncated: false,
        allowed: false,
      };
    }

    // Resolve cwd inside the project root. Model-supplied paths like '/etc'
    // would otherwise let allowlisted commands operate anywhere on disk.
    const requestedCwd = input.cwd ? path.resolve(ctx.projectRoot, input.cwd) : ctx.cwd;
    const rel = path.relative(ctx.projectRoot, requestedCwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: `cwd "${input.cwd}" resolves outside project root`,
        exitCode: 1,
        truncated: false,
        allowed: false,
      };
    }
    const cwd = requestedCwd;
    const signal = opts.signal;

    return runCommand(cmd, args, cwd, timeout, signal, ctx.session?.id);
  },
};

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  sessionId: string | undefined,
): Promise<ExecOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const startedAt = Date.now();
    // Full-output spool (stdout+stderr interleaved as they arrive): the
    // in-memory buffers keep only the first MAX_OUTPUT bytes; the spool
    // captures everything on disk and the result points at the file.
    const spool = createOutputSpool({ tool: `exec-${cmd}`, thresholdBytes: MAX_OUTPUT });

    // On Windows, .cmd/.bat resolution requires shell: true — same rationale
    // as _spawn-stream.ts. resolveWin32Command() finds the full path to the
    // .cmd file so spawn can locate it; shell: true is still needed because
    // .cmd/.bat files are not natively executable by CreateProcess.
    const resolved = resolveWin32Command(cmd);
    const needsShell = isWin && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));

    // On Windows the abort signal is handled manually below: Node's built-in
    // handling kills only the direct child, orphaning grandchildren (vitest
    // forks, dev servers, anything under a .cmd shim) that keep the inherited
    // stdio pipes open. registry.kill() tree-kills via taskkill instead.
    const child = spawn(resolved, args, {
      cwd,
      env: buildChildEnv(sessionId),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(isWin ? {} : { signal }),
      ...(needsShell ? { shell: true, windowsVerbatimArguments: true } : {}),
    });

    const registry = getProcessRegistry();
    const pid = child.pid;
    if (typeof pid === 'number') {
      const fullCommand = `${cmd} ${args.join(' ')}`;
      registry.register({ pid, name: 'exec', command: redactCommand(fullCommand), startedAt: Date.now(), sessionId, child });
    }

    const timer = setTimeout(() => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid);
      else child.kill('SIGTERM');
    }, timeout);

    const onAbort = () => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else child.kill('SIGTERM');
    };
    if (isWin) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length < MAX_OUTPUT) stdout += text;
      spool.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < MAX_OUTPUT) stderr += text;
      spool.write(text);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      const durationMs = Date.now() - startedAt;
      const exitCode = killed ? 124 : (code ?? 1);
      registry.afterCall(durationMs, exitCode !== 0);
      const spooled = spool.finalize();
      resolve({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout) + (spooled ? spoolNote(spooled) : ''),
        stderr: normalizeCommandOutput(stderr),
        exitCode,
        truncated:
          Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES ||
          Buffer.byteLength(stderr, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
        allowed: true,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, true);
      spool.finalize();
      resolve({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout),
        stderr: err.message,
        exitCode: 1,
        truncated: Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
        allowed: true,
      });
    });
  });
}
