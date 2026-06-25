// makePreferSideConflictResolver — a conservative, opt-in merge-conflict resolver
// for an SDD parallel run's worktree integration.
//
// Wired as `SddParallelRunOptions.conflictResolver`, it is consulted when a
// completed task's worktree can't squash-merge cleanly. It rewrites each
// conflicted file by keeping ONE side of every conflict hunk:
//   • 'incoming' — the worktree's changes (theirs); good for generated artefacts
//     a worker is expected to regenerate wholesale.
//   • 'base'     — the already-merged base (ours); discards the worktree's edit.
// The WorktreeManager re-stages and REJECTS the resolution if any conflict marker
// survives (`git diff --cached --check`), so a malformed rewrite degrades safely
// to the conservative retry-on-fresh-base path rather than corrupting the base.
//
// This is intentionally blunt (no semantic merge). It is OFF by default — callers
// opt in explicitly — because auto-picking a side can silently drop work.

import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { TaskNode } from '../types/task-graph.js';

export type ConflictSide = 'incoming' | 'base';

const START = '<<<<<<<';
const BASE = '|||||||';
const SEP = '=======';
const END = '>>>>>>>';

/**
 * Resolve every standard git conflict hunk in `text` by keeping `side`. Handles
 * both 2-way (`<<<<<<< / ======= / >>>>>>>`) and diff3 (`||||||| base`) markers.
 * Returns the rewritten text (markers removed).
 */
export function resolveConflictText(text: string, side: ConflictSide): string {
  const out: string[] = [];
  // 'normal' | 'ours' | 'base' | 'theirs'
  let state: 'normal' | 'ours' | 'base' | 'theirs' = 'normal';
  for (const line of text.split('\n')) {
    const marker = line.slice(0, 7);
    if (state === 'normal' && marker === START) {
      state = 'ours';
      continue;
    }
    if (state !== 'normal' && marker === BASE) {
      state = 'base';
      continue;
    }
    if (state !== 'normal' && marker === SEP) {
      state = 'theirs';
      continue;
    }
    if (state !== 'normal' && marker === END) {
      state = 'normal';
      continue;
    }
    if (state === 'normal') out.push(line);
    else if (state === 'ours' && side === 'base') out.push(line);
    else if (state === 'theirs' && side === 'incoming') out.push(line);
    // 'base' section + the non-selected side are dropped.
  }
  return out.join('\n');
}

/** True when `text` still contains a git conflict marker line. */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((l) => {
    const m = l.slice(0, 7);
    return m === START || m === SEP || m === END || m === BASE;
  });
}

/**
 * Build a `conflictResolver` that keeps `side` of every hunk in each conflicted
 * file. Returns false (abort → conservative fail) if any file can't be read,
 * written, or still has markers after the rewrite.
 */
export function makePreferSideConflictResolver(side: ConflictSide) {
  return async function conflictResolver(info: {
    task: TaskNode;
    conflictFiles: string[];
    cwd: string;
  }): Promise<boolean> {
    if (info.conflictFiles.length === 0) return false;
    for (const rel of info.conflictFiles) {
      const abs = isAbsolute(rel) ? rel : join(info.cwd, rel);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        return false; // can't read → don't risk a partial resolution
      }
      const resolved = resolveConflictText(content, side);
      if (hasConflictMarkers(resolved)) return false; // refuse a half-resolved file
      try {
        await writeFile(abs, resolved, 'utf8');
      } catch {
        return false;
      }
    }
    return true;
  };
}

export interface LlmConflictResolverOptions {
  /** Runs one self-contained, isolated LLM turn and resolves its final text. */
  run: (prompt: string) => Promise<string>;
  /**
   * Reject a resolution that shrinks the file below this fraction of its original
   * non-marker line count — a crude guard against the model dropping content.
   * Default 0.5.
   */
  minRetainedFraction?: number;
}

/** Strip a single surrounding ``` code fence (any/no language) if present. */
function unfence(text: string): string {
  const m = text.match(/^[\s\S]*?```[^\n]*\n([\s\S]*?)\n```[\s\S]*$/);
  return m?.[1] !== undefined ? m[1] : text.trim();
}

/** Original line count ignoring conflict-marker lines (the resolution baseline). */
function nonMarkerLineCount(text: string): number {
  return text.split('\n').filter((l) => {
    const m = l.slice(0, 7);
    return m !== START && m !== SEP && m !== END && m !== BASE;
  }).length;
}

/**
 * Build an LLM-backed `conflictResolver`: for each conflicted file it asks the
 * model (via one isolated `run` turn) to produce the fully resolved file and
 * writes it back. Heavily guarded — returns false (→ conservative abort/retry)
 * if the model leaves a marker, returns junk, or drops too much content. The
 * WorktreeManager STILL rejects any surviving marker, and (when a `verifyTask`
 * is configured) the run re-verifies the integrated base and reverts a
 * regression — so a bad LLM merge can never silently stick. OFF by default.
 */
export function makeLlmConflictResolver(opts: LlmConflictResolverOptions) {
  const minFraction = opts.minRetainedFraction ?? 0.5;

  return async function conflictResolver(info: {
    task: TaskNode;
    conflictFiles: string[];
    cwd: string;
  }): Promise<boolean> {
    if (info.conflictFiles.length === 0) return false;
    for (const rel of info.conflictFiles) {
      const abs = isAbsolute(rel) ? rel : join(info.cwd, rel);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        return false;
      }
      if (!hasConflictMarkers(content)) continue; // already clean — nothing to do

      const prompt = [
        'You are resolving a git MERGE CONFLICT in a single file. Below is the',
        'full file with conflict markers (<<<<<<<, =======, >>>>>>>, and possibly',
        '||||||| for diff3). Combine both sides into the correct, complete file —',
        'keep ALL non-conflicting content verbatim and reconcile each hunk sensibly.',
        'Return ONLY the fully resolved file contents (no conflict markers, no',
        'commentary), optionally wrapped in a single ``` code fence.',
        '',
        `File: ${rel}`,
        '--- BEGIN ---',
        content,
        '--- END ---',
      ].join('\n');

      let out: string;
      try {
        out = await opts.run(prompt);
      } catch {
        return false;
      }
      const resolved = unfence(out ?? '');
      if (!resolved.trim() || hasConflictMarkers(resolved)) return false;
      // Content-drop guard: a resolution far smaller than the original almost
      // certainly lost real work — abort rather than write it.
      if (resolved.split('\n').length < Math.floor(nonMarkerLineCount(content) * minFraction)) {
        return false;
      }
      try {
        await writeFile(abs, resolved, 'utf8');
      } catch {
        return false;
      }
    }
    return true;
  };
}
