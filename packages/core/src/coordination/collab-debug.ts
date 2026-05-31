/**
 * Collaborative Debugging Session — parallel multi-agent debugging on the same problem.
 *
 * Architecture:
 * - BugHunter, RefactorPlanner, and Critic run in parallel on shared file snapshots.
 * - Findings flow through the FleetBus via structured events: bug.found → refactor.plan → critic.evaluation.
 * - The Director acts as ResultRouter, collecting outputs and routing them to dependents.
 * - A shared scratchpad stores intermediate results so agents can read each other's
 *   conclusions without needing each other's full transcripts.
 *
 * Flow:
 *   1. Director.spawnCollab() creates a CollabSession with a SharedFileSnapshot.
 *   2. All three agents are spawned simultaneously and receive the same file snapshot.
 *   3. BugHunter emits bug.found events → Director routes to RefactorPlanner.
 *   4. RefactorPlanner subscribes to bug.found and emits refactor.plan events.
 *   5. Critic subscribes to both bug.found and refactor.plan and emits critic.evaluation.
 *   6. Director collects all results and produces a structured CollabDebugReport.
 */

import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SubagentConfig } from '../types/multi-agent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of target files at the start of a collab session.
 * All agents in the session read from this snapshot — they see the same baseline.
 */
export interface SharedFileSnapshot {
  id: string;
  createdAt: string;
  files: SharedFileEntry[];
}

export interface SharedFileEntry {
  path: string;
  content: string;
  language?: string;
}

/**
 * Bug finding emitted by BugHunter and consumed by RefactorPlanner + Critic.
 */
export interface BugFinding {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: { file: string; line: number };
  description: string;
  suggestedFix?: string;
}

/**
 * Refactoring plan emitted by RefactorPlanner, consuming BugFinding(s).
 */
export interface RefactorPlan {
  id: string;
  basedOnBugIds: string[];
  phases: RefactorPhase[];
  riskScore: 'low' | 'medium' | 'high';
  estimatedChangeCount: number;
  rollbackStrategy: string;
}

/** One phase within a refactor plan. */
export interface RefactorPhase {
  number: number;
  title: string;
  tasks: string[];
  risk: 'low' | 'medium' | 'high';
}

/**
 * Critic evaluation of a bug finding or refactor plan.
 */
export interface CriticEvaluation {
  id: string;
  subjectType: 'bug_finding' | 'refactor_plan';
  subjectId: string;
  score: number; // 0-10
  verdict: 'approve' | 'needs_revision' | 'reject';
  strengths: string[];
  weaknesses: string[];
  concerns: CriticConcern[];
}

export interface CriticConcern {
  description: string;
  location?: { file: string; line: number };
  severity: 'blocking' | 'advisory';
}

/**
 * Full structured report produced when a CollabSession resolves.
 */
export interface CollabDebugReport {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  targetPaths: string[];
  bugs: BugFinding[];
  refactorPlans: RefactorPlan[];
  evaluations: CriticEvaluation[];
  /** Overall verdict from the Critic across all evaluated subjects. */
  overallVerdict: 'approve' | 'needs_revision' | 'reject';
  /** Markdown-formatted summary for the director's context window. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Event payload types (what gets put on the FleetBus)
// ---------------------------------------------------------------------------

export interface BugFoundPayload {
  finding: BugFinding;
}

export interface RefactorPlanPayload {
  plan: RefactorPlan;
}

export interface CriticEvaluationPayload {
  evaluation: CriticEvaluation;
}

// ---------------------------------------------------------------------------
// CollabSession — coordinates the three-agent pipeline
// ---------------------------------------------------------------------------

export interface CollabSessionOptions {
  /** Paths to scan — used to build the SharedFileSnapshot. */
  targetPaths: string[];
  /** Files already read and snapshot. When provided, snapshot is skipped. */
  prebuiltSnapshot?: SharedFileSnapshot;
  /** Max time to wait for the session to resolve (ms). Default: 10 min. */
  timeoutMs?: number;
}

/**
 * Coordinates a collaborative debugging session: spawns BugHunter,
 * RefactorPlanner, and Critic in parallel, routes events between them,
 * and assembles a CollabDebugReport when all three complete.
 */
export class CollabSession extends EventEmitter {
  readonly sessionId: string;
  readonly options: CollabSessionOptions;
  readonly snapshot: SharedFileSnapshot;

  private readonly director: import('./director.js').Director;
  private readonly fleetBus: import('./fleet-bus.js').FleetBus;
  private readonly subagentIds = new Map<string, string>(); // role → subagentId
  private readonly bugs = new Map<string, BugFinding>();
  private readonly plans = new Map<string, RefactorPlan>();
  private readonly evaluations = new Map<string, CriticEvaluation>();
  private readonly disposers = new Array<() => void>();
  private settled = false;
  private readonly timeoutMs: number;

  constructor(
    director: import('./director.js').Director,
    fleetBus: import('./fleet-bus.js').FleetBus,
    options: CollabSessionOptions,
  ) {
    super();
    this.sessionId = randomUUID();
    this.options = options;
    this.director = director;
    this.fleetBus = fleetBus;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

    // Build or use provided snapshot
    if (options.prebuiltSnapshot) {
      this.snapshot = options.prebuiltSnapshot;
    } else {
      // Placeholder — call buildSnapshot() before start() to populate from disk,
      // or pass prebuiltSnapshot to the constructor to avoid async I/O here.
      this.snapshot = {
        id: this.sessionId,
        createdAt: new Date().toISOString(),
        files: [],
      };
    }
  }

  /**
   * Read the target files from disk and populate the snapshot.
   * Call this after construction if you did not provide a prebuiltSnapshot
   * and want the session to operate on real file contents.
   */
  async buildSnapshot(): Promise<SharedFileSnapshot> {
    if (this.snapshot.files.length > 0) return this.snapshot;
    for (const filePath of this.options.targetPaths) {
      try {
        const content = await fsp.readFile(filePath, 'utf8');
        const ext = filePath.split('.').pop() ?? '';
        const language = ext === 'ts' || ext === 'tsx' ? 'typescript'
          : ext === 'js' || ext === 'jsx' ? 'javascript'
          : ext === 'md' ? 'markdown'
          : ext === 'json' ? 'json'
          : undefined;
        this.snapshot.files.push({ path: filePath, content, language });
      } catch {
        this.snapshot.files.push({ path: filePath, content: '', language: undefined });
      }
    }
    return this.snapshot;
  }

  /**
   * Start the collaborative session: snapshot files, spawn all three agents,
   * wire up event routing, and wait for completion.
   */
  async start(): Promise<CollabDebugReport> {
    if (this.settled) throw new Error('session already settled');
    this.settled = true;

    // Wire fleet bus listeners BEFORE spawning so we do not miss any events
    this.wireFleetBus();

    // Spawn all three agents in parallel
    const [bugHunterId, refactorPlannerId, criticId] = await Promise.all([
      this.spawnAgent('bug-hunter', this.buildBugHunterTask()),
      this.spawnAgent('refactor-planner', this.buildRefactorPlannerTask()),
      this.spawnAgent('critic', this.buildCriticTask()),
    ]);

    this.subagentIds.set('bug-hunter', bugHunterId);
    this.subagentIds.set('refactor-planner', refactorPlannerId);
    this.subagentIds.set('critic', criticId);

    // Wait for all three to complete (or timeout)
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`CollabSession timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });

    try {
      await Promise.race([
        Promise.all([
          this.director.awaitTasks([bugHunterId]),
          this.director.awaitTasks([refactorPlannerId]),
          this.director.awaitTasks([criticId]),
        ]),
        timeout,
      ]);
    } catch (err) {
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session.error', error);
      throw error;
    }

    const report = this.assembleReport();
    this.cleanup();
    this.emit('session.done', report);
    return report;
  }

  private async spawnAgent(role: string, taskBrief: string): Promise<string> {
    const cfg: SubagentConfig = {
      id: `${role}-${this.sessionId}`,
      name: role,
      role,
      // fleet_emit is a built-in coordination tool that lets the subagent
      // publish structured events (bug.found, refactor.plan, critic.evaluation)
      // to the fleet bus so the session can route them to other agents.
      // The tool registry must contain 'fleet_emit' — see index.ts exports
      // and the cli multi-agent.ts tool registration wiring.
      tools: ['fleet_emit'],
    };
    const subagentId = await this.director.spawn(cfg);
    await this.director.assign({
      id: randomUUID(),
      subagentId,
      description: taskBrief,
    });
    return subagentId;
  }

  private buildBugHunterTask(): string {
    const paths = this.options.targetPaths.join(', ');
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    return (
      `Scan the following files for bugs and code smells: ${paths}. ` +
      `For each bug found, emit a bug.found event on the fleet bus with this structure:\n` +
      `{ "finding": { "id": "<uuid>", "type": "<pattern>", "severity": "<critical|high|medium|low>", ` +
      `"location": { "file": "<path>", "line": <n> }, "description": "<explain>", "suggestedFix": "<optional>" } }.\n` +
      `After scanning all files, write your full markdown bug report to the shared scratchpad at:\n` +
      `${scratchpad}/bug-hunter-report-${this.sessionId}.md`
    );
  }

  private buildRefactorPlannerTask(): string {
    const paths = this.options.targetPaths.join(', ');
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    return (
      `Plan refactorings for the following files: ${paths}. ` +
      `Listen for bug.found events on the fleet bus from BugHunter. ` +
      `For each bug, create a refactor plan and emit refactor.plan events:\n` +
      `{ "plan": { "id": "<uuid>", "basedOnBugIds": ["<bug-id>"], "phases": [...], "riskScore": "<low|medium|high>", ` +
      `"estimatedChangeCount": <n>, "rollbackStrategy": "<text>" } }.\n` +
      `After planning, write your full markdown plan to:\n` +
      `${scratchpad}/refactor-plan-${this.sessionId}.md`
    );
  }

  private buildCriticTask(): string {
    const scratchpad = this.director.sharedScratchpadPath ?? '/tmp';
    return (
      `Evaluate bug findings and refactor plans as they arrive via fleet bus events. ` +
      `Subscribe to bug.found events (from BugHunter) and refactor.plan events (from RefactorPlanner). ` +
      `For each subject, emit a critic.evaluation event:\n` +
      `{ "evaluation": { "id": "<uuid>", "subjectType": "<bug_finding|refactor_plan>", ` +
      `"subjectId": "<id>", "score": <0-10>, "verdict": "<approve|needs_revision|reject>", ` +
      `"strengths": [...], "weaknesses": [...], "concerns": [...] } }.\n` +
      `After all evaluations, write your markdown critic report to:\n` +
      `${scratchpad}/critic-report-${this.sessionId}.md`
    );
  }

  private wireFleetBus(): void {
    // BugHunter emits bug.found → RefactorPlanner + Critic consume
    const d1 = this.fleetBus.filter('bug.found', (e) => {
      const payload = e.payload as BugFoundPayload;
      if (payload?.finding) {
        this.bugs.set(payload.finding.id, payload.finding);
        this.emit('bug.found', payload);
      }
    });
    this.disposers.push(d1);

    // RefactorPlanner emits refactor.plan → Critic consumes
    const d2 = this.fleetBus.filter('refactor.plan', (e) => {
      const payload = e.payload as RefactorPlanPayload;
      if (payload?.plan) {
        this.plans.set(payload.plan.id, payload.plan);
        this.emit('refactor.plan', payload);
      }
    });
    this.disposers.push(d2);

    // Critic emits critic.evaluation
    const d3 = this.fleetBus.filter('critic.evaluation', (e) => {
      const payload = e.payload as CriticEvaluationPayload;
      if (payload?.evaluation) {
        this.evaluations.set(payload.evaluation.id, payload.evaluation);
        this.emit('critic.evaluation', payload);
      }
    });
    this.disposers.push(d3);
  }

  private assembleReport(): CollabDebugReport {
    const bugList = Array.from(this.bugs.values());
    const planList = Array.from(this.plans.values());
    const evalList = Array.from(this.evaluations.values());

    // Overall verdict: worst verdict across all evaluations
    const verdictOrder: Record<CollabDebugReport['overallVerdict'], number> = {
      approve: 0,
      needs_revision: 1,
      reject: 2,
    };
    const overallVerdict = evalList.reduce<CollabDebugReport['overallVerdict']>(
      (worst, eval_) => {
        const w = verdictOrder[worst];
        const c = verdictOrder[eval_.verdict];
        return c > w ? eval_.verdict : worst;
      },
      'approve',
    );

    const summary = this.buildMarkdownSummary(bugList, planList, evalList, overallVerdict);

    return {
      sessionId: this.sessionId,
      startedAt: this.snapshot.createdAt,
      completedAt: new Date().toISOString(),
      targetPaths: this.options.targetPaths,
      bugs: bugList,
      refactorPlans: planList,
      evaluations: evalList,
      overallVerdict,
      summary,
    };
  }

  private buildMarkdownSummary(
    bugs: BugFinding[],
    plans: RefactorPlan[],
    evals: CriticEvaluation[],
    overallVerdict: CollabDebugReport['overallVerdict'],
  ): string {
    const lines: string[] = [
      `## Collaborative Debugging Report — ${this.sessionId}`,
      '',
      `**Target:** ${this.options.targetPaths.join(', ')}`,
      `**Overall Verdict:** **${overallVerdict.toUpperCase()}**`,
      '',
    ];

    if (bugs.length > 0) {
      lines.push('### Bugs Found', '');
      for (const b of bugs) {
        lines.push(
          `- **[${b.severity.toUpperCase()}]** \`${b.location.file}:${b.location.line}\` — ${b.description}`,
        );
      }
      lines.push('');
    }

    if (plans.length > 0) {
      lines.push('### Refactor Plans', '');
      for (const p of plans) {
        lines.push(`- **Phase plan** (risk: ${p.riskScore}, ~${p.estimatedChangeCount} changes)`);
        for (const phase of p.phases) {
          lines.push(`  - Phase ${phase.number}: ${phase.title} [${phase.risk}]`);
        }
      }
      lines.push('');
    }

    if (evals.length > 0) {
      lines.push('### Critic Evaluations', '');
      for (const e of evals) {
        lines.push(`- [${e.subjectType}] score=${e.score}/10 — **${e.verdict.toUpperCase()}**`);
        for (const c of e.concerns) {
          if (c.severity === 'blocking') {
            lines.push(`  - ${c.description}`);
          }
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private cleanup(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }
}
