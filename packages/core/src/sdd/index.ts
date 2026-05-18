// SDD domain: spec-driven development — parsing, task generation, tracking, flow,
// persistence, interactive building, visualization, and auto-execution.

export { SpecParser } from './spec-parser.js';
export {
  TaskGenerator,
  DefaultTaskStore,
  type TaskGeneratorOptions,
  type GeneratedTask,
} from './task-generator.js';
export {
  TaskTracker,
  type TaskStore,
  type TaskTrackerOptions,
  type TaskTransition,
} from './task-tracker.js';
export {
  TaskFlow,
  SpecDrivenDev,
  type TaskFlowPhase,
  type TaskFlowOptions,
  type TaskFlowExecutionContext,
  type TaskFlowEventMap,
  type TaskFlowEventName,
  type SpecDrivenDevOptions,
} from './task-flow.js';

// Persistence
export { SpecStore, type SpecStoreOptions, type SpecIndexEntry } from './spec-store.js';
export { TaskGraphStore, type TaskGraphStoreOptions, type TaskGraphIndexEntry } from './task-graph-store.js';

// AI-Driven Interactive Builder
export {
  AISpecBuilder,
  type AISpecBuilderOptions,
  type AISpecPhase,
  type AISpecSession,
  type CollectedAnswer,
} from './spec-builder.js';

// Templates
export {
  SPEC_TEMPLATES,
  getTemplate,
  listTemplates,
  templateToMarkdown,
} from './spec-templates.js';

// Visualization
export {
  renderTaskGraph,
  renderProgress,
  renderTaskList,
  renderSpecAnalysis,
} from './task-visualizer.js';

// Critical Path
export { analyzeCriticalPath, type CriticalPathAnalysis, type BottleneckTask } from './critical-path.js';

// Spec Versioning
export { SpecVersioning, type SpecVersion, type SpecDiff } from './spec-versioning.js';

// Auto-Executor
export {
  AutoExecutor,
  createAutoExecutor,
  type AutoExecutorOptions,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type ExecutionSummary,
} from './auto-executor.js';
