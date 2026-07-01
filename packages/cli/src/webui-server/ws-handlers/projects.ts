import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type Agent,
  DefaultSessionStore,
  type MemoryStore,
  type ModeStore,
  type SessionStore,
  type SessionWriter,
  type SkillLoader,
  resolveWstackPaths,
  wstackGlobalRoot,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { loadManifest, touchProjectInManifest } from '../../slash-commands/project-utils.js';
import type { WsCommon } from './index.js';

/**
 * CLI-embedded WebUI project handlers.
 *
 * The standalone WebUI/desktop launcher owns project selection for that
 * surface, but the CLI-embedded WebUI still supports in-process registration
 * and project switching so the browser stays attached to the same live agent.
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
  const resolved = path.resolve(payload.root);
  const displayName = payload.name?.trim() || path.basename(resolved);
  try {
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      ctx.send(ws, {
        type: 'projects.selected',
        payload: { root: resolved, name: displayName, message: `Cannot switch: not a directory: ${resolved}` },
      });
      return;
    }

    const globalRoot = ctx.opts.globalConfigPath
      ? path.resolve(path.dirname(ctx.opts.globalConfigPath))
      : wstackGlobalRoot();
    const nextPaths = resolveWstackPaths({ projectRoot: resolved, globalRoot });
    const nextSessionStore = new DefaultSessionStore({ dir: nextPaths.projectSessions });
    const actx = ctx.opts.agent.ctx;
    const oldWriter = actx.session ?? ctx.opts.session;
    const oldSessionId = oldWriter?.id ?? ctx.opts.session.id;
    const oldUsage = actx.tokenCounter?.total?.() ?? { input: 0, output: 0 };
    const providerId = (actx.provider as { id?: string } | undefined)?.id ?? '';
    const nextWriter = await nextSessionStore.create({
      id: '',
      title: '',
      model: actx.model,
      provider: providerId,
    });

    ctx.abortLegacyRun();
    for (const ctrl of ctx.abortControllers.values()) ctrl.abort();
    ctx.abortControllers.clear();

    await touchProjectInManifest({
      projectRoot: resolved,
      globalConfigPath: ctx.opts.globalConfigPath,
      workingDir: resolved,
      name: displayName,
    });

    ctx.opts.projectRoot = resolved;
    ctx.opts.sessionStore = nextSessionStore;
    ctx.opts.session = nextWriter;

    actx.projectRoot = resolved;
    actx.cwd = resolved;
    actx.workingDir = resolved;
    actx.session = nextWriter;
    actx.state?.replaceMessages?.([]);
    actx.state?.replaceTodos?.([]);
    actx.readFiles?.clear?.();
    actx.fileMtimes?.clear?.();
    actx.tokenCounter?.reset?.();

    if (oldWriter && oldWriter !== nextWriter) {
      const maybeWriter = oldWriter as Partial<SessionWriter>;
      if (typeof maybeWriter.append === 'function') {
        await maybeWriter
          .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
          .catch(() => undefined);
      }
      if (typeof maybeWriter.close === 'function') {
        await maybeWriter.close().catch(() => undefined);
      }
    }

    ctx.opts.onSessionSwapped?.(nextWriter.id);

    ctx.send(ws, {
      type: 'projects.selected',
      payload: { root: resolved, name: displayName, message: `Switched to ${displayName}` },
    });
    const start = await ctx.buildSessionStart({ reset: true, clearedSessionId: oldSessionId });
    ctx.broadcast({ type: 'session.start', payload: start });
  } catch (err) {
    ctx.send(ws, {
      type: 'projects.selected',
      payload: { root: resolved, name: displayName, message: `Cannot switch: ${toErrorMessage(err)}` },
    });
  }
}

export async function handleProjectsAdd(
  ctx: ProjectsContext,
  ws: WebSocket,
  payload: { root: string; name?: string | undefined },
): Promise<void> {
  const resolved = path.resolve(payload.root);
  const displayName = payload.name?.trim() || path.basename(resolved);
  try {
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      ctx.send(ws, {
        type: 'projects.added',
        payload: { name: displayName, root: resolved, slug: '', message: `Not a directory: ${resolved}` },
      });
      return;
    }
    const before = await loadManifest(ctx.opts.globalConfigPath);
    const already = before.projects.some((p) => path.resolve(p.root) === resolved);
    const entry = await touchProjectInManifest({
      projectRoot: resolved,
      globalConfigPath: ctx.opts.globalConfigPath,
      workingDir: resolved,
      name: displayName,
    });
    ctx.send(ws, {
      type: 'projects.added',
      payload: {
        name: entry.name,
        root: entry.root,
        slug: entry.slug,
        message: already
          ? `Already registered project "${entry.name}"`
          : `Registered project "${entry.name}"`,
      },
    });
  } catch (err) {
    ctx.send(ws, {
      type: 'projects.added',
      payload: { name: displayName, root: resolved, slug: '', message: toErrorMessage(err) },
    });
  }
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
