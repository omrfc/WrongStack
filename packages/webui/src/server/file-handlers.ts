/**
 * Shared file-operation WebSocket handlers for both the standalone WebUI
 * server and the CLI's `--webui` embedded server. Extracted from the
 * duplicated switch cases in `index.ts` and `cli/src/webui-server.ts`.
 *
 * Each function handles the full request→response cycle for one message
 * type. Callers drop them into their switch statement:
 *
 *   case 'files.tree': return handleFilesTree(ws, msg, projectRoot);
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { atomicWrite } from '@wrongstack/core';
import { SKIP_DIRS, isHiddenEntry, rankFiles } from './file-picker.js';
import { send, errMessage } from './ws-utils.js';

// ── Type helpers (inlined, no dependence on types.ts) ──

interface FilesListPayload {
  query?: string | undefined;
  limit?: number | undefined;
  /** Optional directory root for the file list (relative to projectRoot).
   *  When set, only files under this directory are returned. */
  path?: string | undefined;
}

interface FilesReadPayload {
  filePath: string;
}

interface FilesWritePayload {
  filePath: string;
  content: string;
}

// ── Shared handlers ───────────────────────────────────────────────────

/**
 * Build and send a nested directory tree for the File Explorer.
 *
 * Walks `projectRoot` to depth 10 max, skipping heavyweight dirs
 * (node_modules, .git, dist, …) and dot-entries. Responds with
 * `{ type: 'files.tree', payload: { root, tree } }`.
 */
export async function handleFilesTree(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: TreeNode[];
  }

  // Use the optional `path` from the message payload as the tree root.
  // When absent, empty, or ".", fall back to projectRoot (backward compatible).
  const payload = (msg as { payload?: { path?: string | undefined } }).payload;
  const rawPath = payload?.path?.trim();
  const treeRoot = rawPath && rawPath !== '.'
    ? path.resolve(projectRoot, rawPath)
    : projectRoot;

  // Guard: treeRoot must stay inside projectRoot.
  if (!treeRoot.startsWith(projectRoot + path.sep) && treeRoot !== projectRoot) {
    send(ws, {
      type: 'files.tree',
      payload: { root: projectRoot, tree: [], error: 'Path outside project root' },
    });
    return;
  }

  // Compute the path prefix so tree paths are always relative to
  // projectRoot (not treeRoot). This ensures double-clicking a file in
  // the explorer sends the correct path to files.read/files.write.
  const pathPrefix = treeRoot === projectRoot
    ? ''
    : (path.relative(projectRoot, treeRoot) + '/').replace(/\\/g, '/');

  async function buildTree(dir: string, rel: string, depth: number): Promise<TreeNode[]> {
    if (depth > 10) return [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (isHiddenEntry(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      // Prepend the workingDir prefix so the path is projectRoot-relative
      const childPath = pathPrefix + childRel;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const children = await buildTree(childAbs, childRel, depth + 1);
        nodes.push({ name: e.name, path: childPath, type: 'directory', children });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: childPath, type: 'file' });
      }
    }
    return nodes;
  }

  try {
    const tree = await buildTree(treeRoot, '', 0);
    const rootLabel = treeRoot === projectRoot
      ? projectRoot
      : path.relative(projectRoot, treeRoot) || '.';
    send(ws, { type: 'files.tree', payload: { root: rootLabel, tree } });
  } catch (err) {
    const rootLabel = treeRoot === projectRoot
      ? projectRoot
      : path.relative(projectRoot, treeRoot) || '.';
    send(ws, {
      type: 'files.tree',
      payload: { root: rootLabel, tree: [], error: errMessage(err) },
    });
  }
}

/**
 * Read a file's content for the Monaco editor.
 *
 * Guards against path traversal (`../` escapes). Responds with
 * `{ type: 'files.read', payload: { filePath, content } }`.
 */
export async function handleFilesRead(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const { filePath } = (msg as { payload: FilesReadPayload }).payload;

  // Path traversal guard: resolve and verify the file stays inside projectRoot.
  const resolved = path.resolve(projectRoot, filePath);
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    send(ws, { type: 'files.read', payload: { filePath, content: '', error: 'Forbidden' } });
    return;
  }

  try {
    const content = await fs.readFile(resolved, 'utf8');
    send(ws, { type: 'files.read', payload: { filePath, content } });
  } catch (err) {
    send(ws, {
      type: 'files.read',
      payload: { filePath, content: '', error: errMessage(err) },
    });
  }
}

/**
 * Write file content back to disk (atomic write via tmp + rename).
 *
 * Guards against path traversal. Responds with
 * `{ type: 'files.written', payload: { filePath, success } }`.
 */
export async function handleFilesWrite(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const { filePath, content } = (msg as { payload: FilesWritePayload }).payload;

  // Path traversal guard.
  const resolved = path.resolve(projectRoot, filePath);
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    send(ws, { type: 'files.written', payload: { filePath, success: false, error: 'Forbidden' } });
    return;
  }

  try {
    await atomicWrite(resolved, content);
    send(ws, { type: 'files.written', payload: { filePath, success: true } });
  } catch (err) {
    send(ws, {
      type: 'files.written',
      payload: { filePath, success: false, error: errMessage(err) },
    });
  }
}

/**
 * Lightweight project file picker for the chat `@` mention popup.
 *
 * Walks `projectRoot` (max depth 8), skipping hidden and heavyweight
 * dirs, then fuzzy-ranks results against `query`. Responds with
 * `{ type: 'files.list', payload: { files } }`.
 */
export async function handleFilesList(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const payload = (msg as { payload?: FilesListPayload }).payload ?? {};
  const limit = payload.limit ?? 50;
  const listRoot = payload.path
    ? path.resolve(projectRoot, payload.path)
    : projectRoot;

  // Guard: listRoot must stay inside projectRoot.
  if (!listRoot.startsWith(projectRoot + path.sep) && listRoot !== projectRoot) {
    send(ws, { type: 'files.list', payload: { files: [] } });
    return;
  }

  const results: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 8 || results.length >= 600) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= 600) return;
      if (isHiddenEntry(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        results.push(childRel);
      }
    }
  }

  await walk(listRoot, '', 0);
  send(ws, {
    type: 'files.list',
    payload: { files: rankFiles(results, payload.query ?? '', limit) },
  });
}
