/**
 * Project route handlers — extracted from the startWebUI closure in index.ts.
 * Mirrors createProviderHandlers/createModeHandlers. WebUI no longer owns
 * project registration or project switching; those actions belong to the
 * launcher/desktop shell. The route still acknowledges stale clients so an old
 * tab cannot silently re-root the live agent.
 */
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import {
  type Context,
  DefaultSessionStore,
  type DefaultMemoryStore,
  type DefaultModeStore,
  type DefaultTokenCounter,
  type SkillLoader,
  type ToolRegistry,
} from '@wrongstack/core';
import type { ConnectedClient } from './types.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';
import { validateWorkingDirSetPayload } from './ws-payload-validation.js';
import { loadManifest } from './projects-manifest.js';
import { resolveWorkingDirInsideProject } from './path-containment.js';

type Session = Awaited<ReturnType<DefaultSessionStore['create']>>;
type SessionStartPayload = {
  sessionId: string;
  model: string;
  provider: string;
  maxContext: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  projectName: string;
  projectRoot: string;
  cwd: string;
  mode: string;
  contextMode: string;
};
type ModelCapabilities = unknown;

export interface ProjectHandlersContext {
  globalConfigPath: string;
  wpaths: { globalRoot: string };
  clients: Map<WebSocket, ConnectedClient>;
  context: Context;
  modeStore: DefaultModeStore;
  memoryStore: DefaultMemoryStore;
  skillLoader: SkillLoader | undefined;
  modelCapabilities: ModelCapabilities;
  toolRegistry: ToolRegistry;
  tokenCounter: DefaultTokenCounter;
  config: { provider: string; model: string };
  // Live reads of the mutable startWebUI bindings.
  getModeId: () => string;
  getProjectRoot: () => string;
  getSession: () => Session;
  // Mutations of the startWebUI bindings.
  setProjectRoot: (p: string) => void;
  setWorkingDir: (p: string) => void;
  setSession: (s: Session) => void;
  setSessionStore: (s: DefaultSessionStore) => void;
  setSessionStartedAt: (t: number) => void;
  /** Abort + clear any in-flight runLock before switching projects. */
  abortRunLock: () => void;
  sessionStartPayload: () => Promise<SessionStartPayload>;
}

export function createProjectHandlers(ctx: ProjectHandlersContext): ProjectRouteHandlers {
  return {
    listProjects: async (ws) => {
      try {
        const manifest = await loadManifest(ctx.globalConfigPath);
        send(ws, { type: 'projects.list', payload: { projects: manifest.projects } });
      } catch (err) {
        send(ws, { type: 'projects.list', payload: { projects: [], error: errMessage(err) } });
      }
    },
    addProject: async (ws, msg) => {
      const payload = msg.payload as { root?: unknown; name?: unknown } | undefined;
      send(ws, {
        type: 'projects.added',
        payload: {
          name: typeof payload?.name === 'string' ? payload.name : '',
          root: typeof payload?.root === 'string' ? payload.root : '',
          slug: '',
          message: 'Project registration is disabled in WebUI. Open/register projects from the launcher or desktop shell.',
        },
      });
    },
    selectProject: async (ws, msg) => {
      const payload = msg.payload as { root?: unknown; name?: unknown } | undefined;
      const root = typeof payload?.root === 'string' ? payload.root : '';
      const name =
        typeof payload?.name === 'string'
          ? payload.name
          : root
            ? path.basename(root)
            : '';
      send(ws, {
        type: 'projects.selected',
        payload: {
          root,
          name,
          message: 'Project switching is disabled in WebUI. Open a project from the launcher or desktop shell instead.',
        },
      });
    },
    setWorkingDir: async (ws, msg) => {
      const parsed = validateWorkingDirSetPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { path: newPath } = parsed.value;
      try {
        const projectRoot = ctx.getProjectRoot();
        const resolved = await resolveWorkingDirInsideProject(projectRoot, newPath);

        ctx.setWorkingDir(resolved);
        ctx.context.cwd = resolved;

        broadcast(ctx.clients, {
          type: 'working_dir.changed',
          payload: { cwd: resolved, projectRoot },
        });

        sendResult(ws, true, `Working directory set to ${resolved}`);
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
  };
}
