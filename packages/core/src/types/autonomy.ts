import type { IterationStage } from '../execution/eternal-autonomy.js';
import type { ParallelIterationStage } from '../execution/parallel-eternal-engine.js';

/** Union of serial and parallel autonomy engine stage types (from EternalAutonomyEngine / ParallelEternalEngine). */
export type AutonomyStage = IterationStage | ParallelIterationStage;
