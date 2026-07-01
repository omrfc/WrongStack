/**
 * session.start payload builder for the CLI WebUI bridge.
 *
 * Builds the payload enriched with per-model cost rates and max-context cap.
 * Used by the initial connect handler and every broadcast path (model.switch,
 * mode.switch, session.resume, etc.) so the frontend always has the correct
 * cost rates for live computation.
 *
 * PR 11 of Issue #30: extracted from `webui-server.ts`.
 */
import * as path from 'node:path';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core';
import type { Context, ModelsRegistry } from '@wrongstack/core';
import { getCostRates } from './cost-helpers.js';

/** The slice of `CliWebUIOptions` the payload builder actually reads. */
export interface SessionStartPayloadDeps {
  agent: { ctx: Context };
  session: { id: string };
  modelsRegistry?: ModelsRegistry | undefined;
  modeId?: string | undefined;
  projectRoot?: string | undefined;
}

export type BuildSessionStartPayload = (
  overrides?: Record<string, unknown>,
  needsSetup?: boolean,
) => Promise<Record<string, unknown>>;

/**
 * Callers pass optional overrides for fields that vary per context
 * (reset, mode, replayMessages, etc.).
 */
export function createSessionStartPayloadBuilder(
  deps: SessionStartPayloadDeps,
): BuildSessionStartPayload {
  return async function buildSessionStartPayload(
    overrides?: Record<string, unknown>,
    needsSetup = false,
  ) {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      if (deps.modelsRegistry) {
        const m = await deps.modelsRegistry.getModel(
          deps.agent.ctx.provider.id,
          deps.agent.ctx.model,
        );
        const registryMax = m?.capabilities.maxContext;
        // Fall back to the live provider's capabilities if the registry has no override.
        // The provider is the authoritative source for the model's default context window.
        maxContext = registryMax ?? deps.agent.ctx.provider.capabilities?.maxContext ?? 0;
        const rates = getCostRates(m);
        inputCost = rates.input;
        outputCost = rates.output;
        cacheReadCost = rates.cacheRead;
      } else {
        // No registry — use the provider's default capabilities directly.
        maxContext = deps.agent.ctx.provider.capabilities?.maxContext ?? 0;
      }
    } catch {
      /* best-effort; cost stays $0 */
    }
    return {
      sessionId: deps.agent.ctx.session?.id ?? deps.session.id,
      model: deps.agent.ctx.model,
      provider: deps.agent.ctx.provider.id,
      mode: deps.modeId ?? 'default',
      projectName: deps.projectRoot ? path.basename(deps.projectRoot) : undefined,
      // Frontend reads `projectRoot` from session.start (ws-handlers setEnv) —
      // omitting it left the store's projectRoot empty after a project switch.
      projectRoot:
        deps.projectRoot ?? (deps.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
      cwd: deps.projectRoot ?? (deps.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
      needsSetup, // true when provider/model not configured and running in --webui mode
      contextMode: String(
        deps.agent.ctx.meta?.['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
      ),
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      ...overrides,
    };
  };
}
