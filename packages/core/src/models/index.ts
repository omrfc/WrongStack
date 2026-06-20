// Models domain: model registry, mode store, LLM selection
export {
  DefaultModelsRegistry,
  classifyFamily,
  type DefaultModelsRegistryOptions,
} from './models-registry.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from './mode-store.js';
export { LLMSelector, type LLMSelectorOptions } from './llm-selector.js';
export {
  resolveProviderModelList,
  describeCatalogModel,
  type ProviderModelDescriptor,
} from './provider-model-resolve.js';

// Model intelligence: capability profiles and auto-routing
export {
  MODEL_PROFILES,
  TASK_TO_ROLE,
  inferTaskType,
  findModelProfile,
  scoreModelForTask,
  type ModelProfile,
  type TaskType,
} from './model-intelligence.js';
export {
  ModelRouter,
  type RouterConfig,
  type ModelPick,
  type RouterCosts,
  type ModelIntelligenceEntry,
} from './model-router.js';
