import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

/**
 * `wrongstack sessions fleet [runId]`
 *
 * Lists fleet run artifacts under `projectSessions/<runId>/`.
 * When runId is omitted, lists all fleet runs discovered under projectSessions.
 *
 * Artifacts shown:
 *   - fleet.json         (manifest)
 *   - checkpoint.json    (state snapshot, if present)
 *   - shared/            (scratchpad directory)
 *   - subagents/         (per-subagent JSONL transcripts)
 */
export const sessionsFleetCmd: SubcommandHandler = async (args, deps) => {
  const runId = args.find((a) => !a.startsWith('-'));

  if (runId) {
    return showFleetRun(runId, deps);
  }
  return listFleetRuns(deps);
};

async function listFleetRuns(deps: SubcommandDeps): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(deps.paths.projectSessions);
  } catch {
    deps.renderer.writeError(`Cannot read projectSessions: ${deps.paths.projectSessions}\n`);
    return 1;
  }

  const runs: Array<{ id: string; manifest: boolean; checkpoint: boolean; subagents: number }> = [];

  for (const id of entries) {
    const runDir = path.join(deps.paths.projectSessions, id);
    let stat;
    try {
      stat = await fsp.stat(runDir);
    } catch {
      continue; // skip inaccessible entries
    }
    if (!stat.isDirectory()) continue;

    let manifest = false;
    let checkpoint = false;
    let subagentCount = 0;
    let subagentsDir: string;

    try {
      await fsp.access(path.join(runDir, 'fleet.json'));
      manifest = true;
    } catch {
      // no manifest
    }

    try {
      await fsp.access(path.join(runDir, 'checkpoint.json'));
      checkpoint = true;
    } catch {
      // no checkpoint
    }

    try {
      subagentsDir = path.join(runDir, 'subagents');
      const files = await fsp.readdir(subagentsDir);
      subagentCount = files.filter((f) => f.endsWith('.jsonl')).length;
    } catch {
      // no subagents dir
    }

    runs.push({ id, manifest, checkpoint, subagents: subagentCount });
  }

  if (runs.length === 0) {
    deps.renderer.write('No fleet runs found.\n');
    return 0;
  }

  deps.renderer.write(color.bold('\nFleet Runs\n') + '\n');
  for (const r of runs.sort((a, b) => b.id.localeCompare(a.id))) {
    const checkpointFlag = r.checkpoint ? color.green('✓') : color.dim('○');
    const manifestFlag = r.manifest ? color.green('✓') : color.dim('○');
    const subagentInfo = r.subagents > 0 ? color.dim(`  ${r.subagents} subagent jsonl`) : '';
    deps.renderer.write(
      `  ${color.bold(r.id)}  ${checkpointFlag} checkpoint  ${manifestFlag} manifest${subagentInfo}\n`,
    );
  }
  deps.renderer.write(
    `\n  ${color.dim('Run `wrongstack sessions fleet <runId>` for details.')}\n`,
  );
  return 0;
}

async function showFleetRun(runId: string, deps: SubcommandDeps): Promise<number> {
  const runDir = path.join(deps.paths.projectSessions, runId);

  let stat;
  try {
    stat = await fsp.stat(runDir);
  } catch {
    deps.renderer.writeError(`Fleet run not found: ${runId}\n`);
    return 1;
  }

  if (!stat.isDirectory()) {
    deps.renderer.writeError(`Not a directory: ${runId}\n`);
    return 1;
  }

  deps.renderer.write(color.bold(`\nFleet Run: ${runId}\n`) + '\n');

  // Manifest
  const manifestPath = path.join(runDir, 'fleet.json');
  let manifestData: string | null = null;
  try {
    manifestData = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestData);
    const subagents = manifest.subagents ?? [];
    const tasks = manifest.tasks ?? [];
    const completed = tasks.filter((t: { status?: string }) => t.status === 'completed' || t.status === 'failed' || t.status === 'timeout' || t.status === 'stopped');
    deps.renderer.write(
      `  ${color.green('✓')} fleet.json — ${subagents.length} subagent(s), ${completed.length}/${tasks.length} tasks done\n`,
    );
  } catch {
    deps.renderer.write(`  ${color.dim('○')} fleet.json — not found\n`);
  }

  // Checkpoint
  const checkpointPath = path.join(runDir, 'checkpoint.json');
  let checkpointData: string | null = null;
  try {
    checkpointData = await fsp.readFile(checkpointPath, 'utf8');
    const snap = JSON.parse(checkpointData);
    const lockPath = `${checkpointPath}.lock`;
    let lockStatus = color.dim('○ no lock');
    try {
      const lockRaw = await fsp.readFile(lockPath, 'utf8');
      const lock = JSON.parse(lockRaw);
      lockStatus = `${color.yellow('▸')} lock held by pid ${lock.pid} on ${lock.hostname} (started ${lock.startedAt})`;
    } catch {
      lockStatus = color.green('✓ no lock (safe to resume)');
    }
    deps.renderer.write(
      `  ${color.green('✓')} checkpoint.json — updated ${snap.updatedAt}, ${snap.spawnCount} spawns, ${snap.tasks?.length ?? 0} tasks tracked\n    ${lockStatus}\n`,
    );
  } catch {
    deps.renderer.write(`  ${color.dim('○')} checkpoint.json — not found\n`);
  }

  // State snapshot
  if (checkpointData) {
    try {
      const snap = JSON.parse(checkpointData);
      if (snap.subagents?.length) {
        deps.renderer.write('\n  Subagents:\n');
        for (const s of snap.subagents) {
          deps.renderer.write(
            `    ${color.cyan(s.id)}  ${s.name ? `${s.name} ` : ''}${s.provider ? `(${s.provider}/${s.model})` : ''}  spawned ${s.spawnedAt}\n`,
          );
        }
      }
      if (snap.tasks?.length) {
        deps.renderer.write('\n  Tasks:\n');
        for (const t of snap.tasks) {
          deps.renderer.write(
            `    ${color.dim(t.taskId)}  ${t.status}  ${t.description ? t.description.slice(0, 50) : '(no description)'}\n`,
          );
        }
      }
    } catch {
      // skip parse errors
    }
  }

  // Subagents directory
  const subagentsDir = path.join(runDir, 'subagents');
  let subagentFiles: string[] = [];
  try {
    subagentFiles = await fsp.readdir(subagentsDir);
    subagentFiles = subagentFiles.filter((f) => f.endsWith('.jsonl'));
  } catch {
    // no subagents dir
  }

  if (subagentFiles.length > 0) {
    deps.renderer.write(`\n  Subagent transcripts (${subagentFiles.length}):\n`);
    for (const f of subagentFiles.sort()) {
      const filePath = path.join(subagentsDir, f);
      let size: number;
      try {
        const s = await fsp.stat(filePath);
        size = s.size;
      } catch {
        size = 0;
      }
      const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`;
      deps.renderer.write(`    ${color.dim(f)}  ${color.dim(sizeStr)}\n`);
    }
  } else {
    deps.renderer.write(`\n  ${color.dim('○')} No subagent transcripts\n`);
  }

  // Shared directory
  const sharedDir = path.join(runDir, 'shared');
  try {
    const files = await fsp.readdir(sharedDir);
    deps.renderer.write(`\n  Shared scratchpad: ${files.length} file(s)\n`);
  } catch {
    deps.renderer.write(`\n  ${color.dim('○')} No shared scratchpad\n`);
  }

  deps.renderer.write(
    `\n  ${color.dim('Resume: wrongstack --resume ' + runId)}\n`,
  );
  return 0;
}