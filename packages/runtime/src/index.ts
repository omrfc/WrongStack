/**
 * @wrongstack/runtime
 *
 * Transitional home for concrete runtime implementations.
 *
 * The long-term package boundary is:
 *   - @wrongstack/core: kernel, agent runtime, registries, public contracts.
 *   - @wrongstack/runtime: default storage, security, config, observability,
 *     compaction, models, skills, and host composition helpers.
 *
 * For this first refactor slice, the implementations still physically live in
 * @wrongstack/core and are re-exported here. That gives hosts a stable import
 * target while later moves can happen behind this facade.
 */

export * from '@wrongstack/core/defaults';
export {
  DefaultPathResolver,
  DefaultTokenCounter,
} from '@wrongstack/core/infrastructure';
export {
  DefaultSystemPromptBuilder,
  type DefaultSystemPromptBuilderOptions,
} from '@wrongstack/core';
export * from './pack.js';
export * from './host.js';
export * from './vision.js';
export * from './clipboard.js';
