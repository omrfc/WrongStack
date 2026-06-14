import { spawn } from 'node:child_process';

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command (argv form) in a directory and capture its result. Used by the
 * deterministic graders to run a suite's own test command — the run's exit code
 * is the pass/fail signal, no LLM involved.
 *
 * Never rejects; a spawn failure surfaces as exitCode null with the error on
 * stderr.
 */
export function execCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Run through a shell. Needed for launchers that resolve platform wrappers
   * (`npm` → npm.cmd on Windows, `./gradlew`). Defaults to true. Pass false for
   * real executables (git, python, node, cargo, go) to avoid the shell entirely
   * — no metacharacter interpretation, no DEP0190, no injection surface.
   */
  shell?: boolean | undefined;
}): Promise<ExecResult> {
  const useShell = opts.shell ?? true;
  return new Promise<ExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      if (useShell) {
        // Build a SINGLE command string rather than passing an args array with
        // `shell:true` — the latter triggers Node's DEP0190 warning and does
        // not escape the args anyway. Trusted, benchmark-defined commands only.
        const line = [opts.command, ...opts.args.map(shellQuote)].join(' ');
        child = spawn(line, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          windowsHide: true,
          shell: true,
        });
      } else {
        // No shell: args are passed verbatim to the program, so nothing in them
        // is interpreted. Preferred for git/python/etc.
        child = spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          windowsHide: true,
        });
      }
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}

/** Quote a single arg for the shell only when it contains whitespace. */
function shellQuote(arg: string): string {
  if (arg.length > 0 && !/\s/.test(arg)) return arg;
  // Wrap in double quotes and escape any embedded double quotes. Sufficient for
  // the benchmark's own test commands (no untrusted shell metacharacters).
  return `"${arg.replace(/"/g, '\\"')}"`;
}
