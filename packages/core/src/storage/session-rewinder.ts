import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CheckpointInfo, RewindResult, RewindResultExtended, SessionRewinder } from '../types/session-rewinder.js';
import type { SessionEvent, FileSnapshot } from '../types/session.js';

export interface SessionRewinderOptions {
  sessionsDir: string;
}

/**
 * Rewind engine that reads session JSONL files and reverts file system
 * changes to any previous checkpoint.
 */
export class DefaultSessionRewinder implements SessionRewinder {
  constructor(private readonly sessionsDir: string) {}

  async listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    // Build a map of promptIndex -> file snapshot count
    const fileCountMap = new Map<number, number>();
    for (const event of events) {
      if (event.type === 'file_snapshot') {
        const e = event as { promptIndex: number; files: FileSnapshot[] };
        fileCountMap.set(e.promptIndex, (fileCountMap.get(e.promptIndex) ?? 0) + e.files.length);
      }
    }

    const checkpoints: CheckpointInfo[] = [];
    for (const event of events) {
      if (event.type === 'checkpoint') {
        const e = event as { promptIndex: number; promptPreview: string; ts: string };
        checkpoints.push({
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
          fileCount: fileCountMap.get(e.promptIndex) ?? 0,
        });
      }
    }

    return checkpoints;
  }

  async rewindToCheckpoint(
    sessionId: string,
    checkpointIndex: number,
  ): Promise<RewindResultExtended> {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    let targetIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === 'checkpoint') {
        const checkpointEvent = event as { promptIndex: number };
        if (checkpointEvent.promptIndex === checkpointIndex) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      throw new Error(`Checkpoint ${checkpointIndex} not found`);
    }

    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for (let i = targetIdx + 1; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === 'checkpoint') {
        break;
      }
      if (event.type === 'file_snapshot') {
        const snapshotEvent = event as { promptIndex: number; files: FileSnapshot[] };
        if (snapshotEvent.promptIndex >= checkpointIndex) {
          snapshotsToRevert.push({ promptIndex: snapshotEvent.promptIndex, files: snapshotEvent.files });
        }
      }
    }

    const result = await revertSnapshots(snapshotsToRevert);
    const removedEvents = events.length - targetIdx - 1;
    return { ...result, toPromptIndex: checkpointIndex, removedEvents };
  }

  async rewindLastN(sessionId: string, n: number): Promise<RewindResultExtended> {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    const checkpoints: Array<{ promptIndex: number; ts: string }> = [];
    for (const event of events) {
      if (event.type === 'checkpoint') {
        checkpoints.push({ promptIndex: event.promptIndex, ts: event.ts });
      }
    }

    if (checkpoints.length === 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    checkpoints.sort((a, b) => b.promptIndex - a.promptIndex);
    const targetIndex = checkpoints[n]?.promptIndex ?? 0;

    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    let shouldRevert = false;

    for (const event of events) {
      if (event.type === 'checkpoint' && event.promptIndex === targetIndex) {
        shouldRevert = true;
        continue;
      }
      if (shouldRevert && event.type === 'file_snapshot') {
        snapshotsToRevert.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    const result = await revertSnapshots(snapshotsToRevert.reverse());
    return { ...result, toPromptIndex: targetIndex, removedEvents: snapshotsToRevert.length };
  }

  async rewindToStart(sessionId: string): Promise<RewindResultExtended> {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    const allSnapshots: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for (const event of events) {
      if (event.type === 'file_snapshot') {
        allSnapshots.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    if (allSnapshots.length === 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    const result = await revertSnapshots(allSnapshots.reverse());
    return { ...result, toPromptIndex: 0, removedEvents: allSnapshots.length };
  }
}

function parseEvents(raw: string): SessionEvent[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  const events: SessionEvent[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { type?: unknown }).type === 'string' &&
        typeof (parsed as { ts?: unknown }).ts === 'string'
      ) {
        events.push(parsed as SessionEvent);
      }
    } catch {
      // skip malformed
    }
  }

  return events;
}

async function revertSnapshots(
  snapshots: Array<{ promptIndex: number; files: FileSnapshot[] }>,
): Promise<RewindResult> {
  const revertedFiles: string[] = [];
  const errors: string[] = [];

  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      try {
        if (file.action === 'deleted') {
          // File was deleted — restore it from before
          if (file.before !== null) {
            await fsp.writeFile(file.path, file.before, { mode: 0o644 });
            revertedFiles.push(file.path);
          }
        } else if (file.action === 'created') {
          // File was created — delete it
          await fsp.unlink(file.path);
          revertedFiles.push(file.path);
        } else if (file.action === 'modified') {
          // File was modified — restore before content
          if (file.before !== null) {
            await fsp.writeFile(file.path, file.before, { mode: 0o644 });
            revertedFiles.push(file.path);
          }
        }
      } catch (err) {
        errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { revertedFiles, errors };
}