import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type Agent,
  type MemoryStore,
  type ModeStore,
  type SessionStore,
  type SessionWriter,
  type SkillLoader,
  wstackGlobalRoot,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * WebUI no longer owns project registration or project switching. The launcher
 * / desktop shell owns project selection, and stale WebUI clients receive an
 * explicit disabled response instead of re-rooting the live agent.
 */

/** The subset of CliWebUIOptions the project handlers read/mutate. Passed by reference. */
export interface ProjectsOptions {
  projectRoot?: string | undefined;
  globalConfigPath?: string | undefined;
  agent: Agent;
  modeId?: string | undefined;
  modeStore?: ModeStore | undefined;
  memoryStore?: MemoryStore | undefined;
  skillLoader?: SkillLoader | undefined;
  sessionStore?: SessionStore | undefined;
  session: SessionWriter;
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
}

export interface ProjectsContext extends WsCommon {
  /** The live options object used by projects.list and working_dir.set. */
  opts: ProjectsOptions;
  /** Kept for compatibility with the embedded WebUI context wiring. */
  abortControllers: Map<WebSocket, AbortController>;
  /** Kept for compatibility with the embedded WebUI context wiring. */
  abortLegacyRun: () => void;
  /** Kept for compatibility with the embedded WebUI context wiring. */
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleProjectsList(ctx: ProjectsContext, ws: WebSocket): Promise<void> {
  // Read the project manifest from ~/.wrongstack/projects.json
  const projectsBase = ctx.opts.globalConfigPath
    ? path.resolve(path.dirname(ctx.opts.globalConfigPath))
    : wstackGlobalRoot();
  const manifestPath = path.join(projectsBase, 'projects.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      projects: Array<{ name: string; root: string; slug: string; lastSeen?: string }>;
    };
    ctx.send(ws, { type: 'projects.list', payload: { projects: manifest.projects ?? [] } });
  } catch {
    ctx.send(ws, { type: 'projects.list', payload: { projects: [] } });
  }
}

export async function handleProjectsSelect(
  ctx: ProjectsContext,
  ws: WebSocket,
  payload: { root: string; name?: string | undefined },
): Promise<void> {
  const { root, name: projectName } = payload;
  ctx.send(ws, {
    type: 'projects.selected',
    payload: {
      root,
      name: projectName?.trim() || path.basename(root),
      message: 'Project switching is disabled in WebUI. Open a project from the launcher or desktop shell instead.',
    },
  });
}

export async function handleProjectsAdd(
  ctx: ProjectsContext,
  ws: WebSocket,
  payload: { root: string; name?: string | undefined },
): Promise<void> {
  const { root: addRoot, name: addName } = payload;
  ctx.send(ws, {
    type: 'projects.added',
    payload: {
      name: addName?.trim() || path.basename(addRoot),
      root: addRoot,
      slug: '',
      message: 'Project registration is disabled in WebUI. Open/register projects from the launcher or desktop shell.',
    },
  });
}

export async function handleWorkingDirSet(
  ctx: ProjectsContext,
  ws: WebSocket,
  newPath: string,
): Promise<void> {
  try {
    const wdRoot = ctx.opts.projectRoot ?? ctx.opts.agent.ctx.projectRoot;
    const resolved = path.resolve(wdRoot, newPath);
    if (!resolved.startsWith(wdRoot + path.sep) && resolved !== wdRoot) {
      sendResult(ctx, ws, false, `Path must stay inside the project root: ${wdRoot}`);
      return;
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      sendResult(ctx, ws, false, `Directory not found or not accessible: ${resolved}`);
      return;
    }
    ctx.opts.agent.ctx.cwd = resolved;
    ctx.broadcast({ type: 'working_dir.changed', payload: { cwd: resolved, projectRoot: wdRoot } });
    sendResult(ctx, ws, true, `Working directory set to ${resolved}`);
  } catch (err) {
    sendResult(ctx, ws, false, toErrorMessage(err));
  }
}
