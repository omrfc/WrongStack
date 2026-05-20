import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core';
import { buildChildEnv } from './_env.js';
import { getProcessRegistry } from './process-registry.js';

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
const MAX_OUTPUT = 200_000;
const TIMEOUT_MS = 30_000;

// Per-command argument validation. Each entry is a list of regex patterns
// that, if matched against any argument, will reject the invocation.
// This blocks common injection vectors through allowlisted commands.
const BLOCKED_ARG_PATTERNS: Record<string, RegExp[]> = {
  // python -c/--command executes arbitrary code; python -m runs modules
  python: [/-c$/, /^--command$/, /^-m$/, /^--module$/],
  // git --exec=<cmd> runs arbitrary commands via upload-pack/receive-pack;
  // -C <dir> changes working directory, bypassing cwd sandbox
  git: [/^--exec=/, /^--upload-pack=/, /^--receive-pack=/, /^-C$/],
  // node -r/--require preloads arbitrary modules; --eval executes code
  node: [/^-r$/, /^--require$/, /^-e$/, /^--eval$/, /^--prof-process$/],
  // go run could execute arbitrary .go files; -ldflags could inject build-time code
  go: [/^-ldflags$/],
  // bun --preload is similar to node --require
  bun: [/^--preload$/],
  // docker build/run can create containers with host access;
  // only allow read-only commands (ps, images, version)
  docker: [/^build$/, /^run$/, /^exec$/, /^push$/, /^pull$/],
  // find -exec/-ok/-execdir execute arbitrary commands
  find: [/^-exec$/, /^-exec;$/, /^-ok$/, /^-ok;$/, /^-execdir$/, /^-execdir;$/, /^-exec=/, /^-ok=/, /^-execdir=/],
  // rm -rf / is catastrophic — block root and home targets
  rm: [/^\/$/, /^\/\*$/, /^~$/],
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
  args?: string[];
  cwd?: string;
  timeout?: number;
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
    'Restricted shell that only runs pre-approved commands with constrained arguments. Safer alternative to `bash`.',
  usageHint:
    'Set `command` (must be in allowlist). `args` passed through. For arbitrary shell access use the `bash` tool instead.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to run (must be in allowlist)' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments' },
      cwd: { type: 'string', description: 'Working directory (must resolve inside project root)' },
      timeout: { type: 'integer', description: 'Timeout in ms (default: 30000)' },
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
    const timeout = Math.max(1, Math.min(input.timeout ?? TIMEOUT_MS, TIMEOUT_MS));

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

    const child = spawn(cmd, args, {
      cwd,
      signal,
      env: buildChildEnv(sessionId),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const registry = getProcessRegistry();
    const pid = child.pid;
    if (typeof pid === 'number') {
      const fullCommand = `${cmd} ${args.join(' ')}`;
      registry.register({ pid, name: 'exec', command: fullCommand, startedAt: Date.now(), sessionId, child });
    }

    const timer = setTimeout(() => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid);
      else child.kill('SIGTERM');
    }, timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof pid === 'number') registry.unregister(pid);
      const durationMs = Date.now() - startedAt;
      const exitCode = killed ? 124 : (code ?? 1);
      registry.afterCall(durationMs, exitCode !== 0);
      resolve({
        command: cmd,
        args,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode,
        truncated: stdout.length >= MAX_OUTPUT || stderr.length >= MAX_OUTPUT,
        allowed: true,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, true);
      resolve({
        command: cmd,
        args,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: err.message,
        exitCode: 1,
        truncated: false,
        allowed: true,
      });
    });
  });
}
