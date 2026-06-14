import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Per-run isolation. Each benchmark run gets one sandbox directory tree:
 *
 *   <sandbox>/
 *     home/        → isolated WRONGSTACK_HOME (config seed + all session JSONL)
 *     work/<id>/   → one copy of a task template per (task × cell)
 *
 * The isolated home keeps the bench off the developer's real ~/.wrongstack
 * (config, sessions, models cache). Each task workdir hashes to its own
 * project slug under home/projects/, so concurrent runs never share a session
 * file even though they share one home.
 */
export interface Sandbox {
  /** Root sandbox dir. */
  root: string;
  /** Isolated WRONGSTACK_HOME. */
  homeDir: string;
  /** Directory that holds per-task workdirs. */
  workRoot: string;
}

/** Create the sandbox tree and seed the isolated home's config.json. */
export async function createSandbox(opts: {
  /** Where to create the sandbox. Defaults to an OS temp dir. */
  baseDir?: string | undefined;
  maxIterations: number;
  yolo: boolean;
}): Promise<Sandbox> {
  const base = opts.baseDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bench-')));
  await fs.mkdir(base, { recursive: true });
  const homeDir = path.join(base, 'home');
  const workRoot = path.join(base, 'work');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workRoot, { recursive: true });

  // Seed config.json so the subprocess inherits the iteration cap and runs
  // unattended (yolo). auditLevel 'standard' guarantees tool_call_end events
  // land in the session JSONL — session-metrics depends on them. No secrets
  // are written here: provider keys come from the inherited env.
  const config = {
    yolo: opts.yolo,
    tools: { maxIterations: opts.maxIterations },
    session: { auditLevel: 'standard' },
  };
  await fs.writeFile(path.join(homeDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  return { root: base, homeDir, workRoot };
}

/**
 * Copy a task template into a fresh workdir. The directory name embeds the
 * cell label and task id so it is both unique (parallel-safe) and debuggable.
 */
export async function prepareWorkdir(
  sandbox: Sandbox,
  templateDir: string,
  taskId: string,
  cellLabel: string,
  exclude?: string[] | undefined,
): Promise<string> {
  const safe = `${slug(cellLabel)}__${slug(taskId)}`;
  const dest = path.join(sandbox.workRoot, safe);
  // Fresh copy every time: a previous failed run must not leak edits forward.
  await fs.rm(dest, { recursive: true, force: true });
  const excludeSet = new Set(exclude ?? []);
  await fs.cp(templateDir, dest, {
    recursive: true,
    // Drop any path whose segments include an excluded name (e.g. `.meta`),
    // so the reference solution never reaches the agent's workdir.
    filter:
      excludeSet.size === 0
        ? undefined
        : (src) => !src.split(/[\\/]/).some((seg) => excludeSet.has(seg)),
  });
  return dest;
}

/** Remove the whole sandbox tree. Best-effort. */
export async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  await fs.rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}
