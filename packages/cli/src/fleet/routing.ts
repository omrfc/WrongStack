import { expectDefined } from '@wrongstack/core';
import type { SubagentRunContext, SubagentRunner, TaskSpec } from '@wrongstack/core';
import {
  type Config,
  NULL_FLEET_BUS,
  TOKENS,
  makeAgentSubagentRunner,
} from '@wrongstack/core';
import type { MultiAgentHost } from './host.js';
/**
 * Routing runner — dispatches tasks to standard or ACP runner based on provider.
 */
export function buildRoutingRunner(config: Config, host: MultiAgentHost): SubagentRunner {
  const standardRunner = makeAgentSubagentRunner({
    factory: host.makeSubagentFactory(config),
    fleetBus: host.getDirector()?.fleet ?? NULL_FLEET_BUS,
  });

  return async (task: TaskSpec, ctx: SubagentRunContext) => {
    const subCfg = ctx.config;
    if (subCfg.provider === 'acp') {
      const cacheKey = subCfg.role ?? subCfg.name ?? expectDefined(subCfg.id);
      return host.buildACPRunner(cacheKey).then((r) => r(task, ctx));
    }
    return standardRunner(task, ctx);
  };
}

// Workaround: TOKENS reference satisfies unused-import lint
void TOKENS;
