import { execFile } from 'node:child_process';
import type { Context, SlashCommand } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LINES = 500;

function runCommand(
  cmd: string,
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; killed: boolean }> {
  return new Promise((resolve) => {
    // exec() always spawns a shell on both POSIX and Windows, interpreting
    // metacharacters (& | ; $ ( ) etc.) as shell code — a injection vector
    // when user input reaches the command string.
    //
    // execFile() with shell:false bypasses the shell on POSIX: the command
    // string is passed as a single argv[] element, so metacharacters are
    // passed literally and not interpreted.
    // On Windows execFile doesn't support shell:false; shell:true uses cmd.exe
    // which correctly quotes the combined string argument.
    const opts = {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024, // 2 MB
      windowsHide: true,
      // On POSIX: no shell → command string is a literal argument.
      // On Windows: shell:true → cmd.exe /c "..." handles quoting.
      shell: process.platform === 'win32' ? true : false,
    };
    execFile(cmd, [], opts, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: (typeof error?.code === 'number' ? error.code : 0),
        killed: error?.killed ?? false,
      });
    });
  });
}

function formatOutput(
  cmd: string,
  result: { stdout: string; stderr: string; exitCode: number; killed: boolean },
  elapsed: number,
): string {
  const lines: string[] = [];

  // Header
  const exitLabel = result.killed
    ? color.red('TIMEOUT')
    : result.exitCode === 0
      ? color.green('OK')
      : color.red(`EXIT ${result.exitCode}`);
  lines.push(`${color.cyan('$')} ${color.bold(cmd)}  ${exitLabel}  ${color.dim(`${elapsed}ms`)}`);

  // Output
  const combined = (result.stdout + result.stderr).trimEnd();
  if (combined) {
    const outputLines = combined.split('\n');
    const truncated = outputLines.length > MAX_OUTPUT_LINES;
    const shown = truncated ? outputLines.slice(0, MAX_OUTPUT_LINES) : outputLines;

    lines.push('');
    lines.push(color.dim('──'));
    for (const line of shown) {
      lines.push(line);
    }
    if (truncated) {
      lines.push(
        color.dim(
          `… (truncated, showing first ${MAX_OUTPUT_LINES} of ${outputLines.length} lines)`,
        ),
      );
    }
    lines.push(color.dim('──'));
  } else {
    lines.push(color.dim('(no output)'));
  }

  return lines.join('\n');
}

/**
 * `/dev <shell command>` — execute a shell command from the chat input and
 * display its output. The LLM does NOT see the result — this is a developer
 * convenience shortcut, not a tool invocation.
 */
export function buildDevCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'dev',
    category: 'Run',
    description: 'Run a shell command and see the output (LLM does not see it).',
    argsHint: '<shell command>',
    help: [
      'Usage:',
      '  /dev <shell command>    Run a command from the chat input.',
      '',
      'Examples:',
      '  /dev pnpm release:check',
      '  /dev git diff --stat',
      '  /dev ls -la src/',
      '',
      'The command runs in the current working directory. Output is displayed',
      'in the chat history but is NOT fed to the LLM — use this for your own',
      'eyes only. Timeout: 60s. Max output: 500 lines.',
      '',
      'This is a convenience shortcut — equivalent to switching to a terminal',
      'tab. For commands the LLM should see, use the `exec` tool instead.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const cmd = args.trim();
      if (!cmd) {
        return {
          message: `${color.yellow('Usage:')} /dev <shell command>\n\nExamples:\n  /dev pnpm release:check\n  /dev git diff --stat`,
        };
      }

      const cwd = opts.cwd;
      const startedAt = Date.now();

      opts.renderer.write(color.dim(`$ ${cmd}`));

      const result = await runCommand(cmd, cwd, DEFAULT_TIMEOUT_MS);
      const elapsed = Date.now() - startedAt;

      const display = formatOutput(cmd, result, elapsed);
      return { message: display };
    },
  };
}
