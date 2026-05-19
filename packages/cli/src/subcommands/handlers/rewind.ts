import * as path from 'node:path';
import {
  DefaultSessionRewinder,
  DefaultSessionStore,
  type CheckpointInfo,
  color,
  resolveWstackPaths,
} from '@wrongstack/core';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

interface RewindFlags {
  all?: boolean;
  last?: string;
  to?: string;
  list?: boolean;
  resume?: boolean;
}

function parseRewindFlags(args: string[]): RewindFlags {
  const flags: RewindFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--last') flags.last = args[++i] ?? '1';
    else if (a === '--to') flags.to = args[++i] ?? '';
    else if (a === '--list') flags.list = true;
    else if (a === '--resume') flags.resume = true;
  }
  return flags;
}

export const rewindCmd: SubcommandHandler = async (args, deps) => {
  const flags = parseRewindFlags(args);

  // Use global sessions path: ~/.wrongstack/sessions/
  const wpaths = resolveWstackPaths({ projectRoot: deps.projectRoot });
  const sessionsDir = path.join(wpaths.globalRoot, 'sessions');

  const rewind = new DefaultSessionRewinder(sessionsDir);

  // Get session ID — either from --to argument or latest session
  let sessionId = args.find((a) => !a.startsWith('--'));
  if (!sessionId) {
    if (!deps.sessionStore) {
      deps.renderer.writeError('No session store available.');
      return 1;
    }
    const sessions = await deps.sessionStore.list(1);
    if (sessions.length === 0) {
      deps.renderer.writeError('No sessions found.');
      return 1;
    }
    sessionId = sessions[0]!.id;
  }

  // List checkpoints
  if (flags.list) {
    deps.renderer.write(`Session: ${color.bold(sessionId)}\n\n`);
    const checkpoints = await rewind.listCheckpoints(sessionId);
    if (checkpoints.length === 0) {
      deps.renderer.write('No checkpoints in this session.\n');
      return 0;
    }
    for (const cp of checkpoints) {
      deps.renderer.write(
        `  [${cp.promptIndex}] ${color.dim(cp.ts)}  ${cp.promptPreview}${cp.fileCount > 0 ? color.dim(` (${cp.fileCount} file${cp.fileCount === 1 ? '' : 's'})`) : ''}\n`,
      );
    }
    return 0;
  }

  // Perform rewind
  try {
    let result;
    if (flags.all) {
      deps.renderer.write('Rewinding to session start...\n');
      result = await rewind.rewindToStart(sessionId);
    } else if (flags.last) {
      const n = parseInt(flags.last, 10);
      if (isNaN(n) || n < 1) {
        deps.renderer.writeError('--last requires a positive number');
        return 1;
      }
      deps.renderer.write(`Rewinding last ${n} prompt(s)...\n`);
      result = await rewind.rewindLastN(sessionId, n);
    } else if (flags.to) {
      const idx = parseInt(flags.to, 10);
      if (isNaN(idx) || idx < 0) {
        deps.renderer.writeError('--to requires a non-negative number');
        return 1;
      }
      deps.renderer.write(`Rewinding to checkpoint ${idx}...\n`);
      result = await rewind.rewindToCheckpoint(sessionId, idx);
    } else {
      deps.renderer.write('Usage: ws rewind --all | --last N | --to <index> [--list] [--resume]\n');
      deps.renderer.write('  --all      Rewind to session start\n');
      deps.renderer.write('  --last N   Rewind last N prompts\n');
      deps.renderer.write('  --to N     Rewind to checkpoint N\n');
      deps.renderer.write('  --list     List checkpoints\n');
      deps.renderer.write('  --resume   After rewind, truncate session history at checkpoint\n');
      return 1;
    }

    if (result.revertedFiles.length === 0) {
      deps.renderer.write('No files to revert.\n');
      if (flags.resume) {
        // Still truncate even if no files changed
        const store = new DefaultSessionStore({ dir: sessionsDir });
        const resumed = await store.resume(sessionId);
        const toIdx = (result as unknown as { toPromptIndex: number }).toPromptIndex;
        await (resumed.writer as unknown as { truncateToCheckpoint(n: number): Promise<number> }).truncateToCheckpoint(toIdx);
        await resumed.writer.close();
        deps.renderer.write(`  ${color.green('✓')} Session truncated at checkpoint ${toIdx}\n`);
      }
      return 0;
    }

    deps.renderer.write(`\nReverted ${result.revertedFiles.length} file(s):\n`);
    for (const f of result.revertedFiles) {
      deps.renderer.write(`  ${color.green('✓')} ${f}\n`);
    }

    if (flags.resume) {
      const store = new DefaultSessionStore({ dir: sessionsDir });
      const resumed = await store.resume(sessionId);
      const toIdx = (result as unknown as { toPromptIndex: number }).toPromptIndex;
      const removed = await (resumed.writer as unknown as { truncateToCheckpoint(n: number): Promise<number> }).truncateToCheckpoint(toIdx);
      await resumed.writer.close();
      deps.renderer.write(`\n  ${color.green('✓')} Session truncated — ${removed} event(s) removed\n`);
    }

    if (result.errors.length > 0) {
      deps.renderer.write(`\n${result.errors.length} error(s):\n`);
      for (const e of result.errors) {
        deps.renderer.write(`  ${color.red('✗')} ${e}\n`);
      }
      return 1;
    }
    return 0;
  } catch (err) {
    deps.renderer.writeError(err instanceof Error ? err.message : String(err));
    return 1;
  }
};