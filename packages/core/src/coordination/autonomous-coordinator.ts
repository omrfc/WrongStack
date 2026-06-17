/**
 * CoordinatorEvent — union of all event types emitted by the AutonomousCoordinator.
 * Consumed by the TUI to drive coordinator panel state and the reducer.
 */
export type CoordinatorEvent =
  | { type: 'goal:added'; goalId: string; title?: string; text?: string; participants?: string[] }
  | { type: 'goal:completed'; goalId: string; text?: string; participants?: string[] }
  | { type: 'goal:failed'; goalId: string; text?: string }
  | { type: 'task:ready'; goalId: string; taskId: string; title?: string; assignedTo?: string; text?: string }
  | { type: 'task:completed'; goalId: string; taskId: string; text?: string }
  | { type: 'knowledge:added'; knowledgeId: string; title?: string; text?: string }
  | { type: 'consensus:reached'; goalId: string; text?: string; participants?: string[] }
  | { type: 'deadlock:detected'; goalId: string; text?: string };

/**
 * AutonomousCoordinator — wires all coordination components into one self-directing engine.
 *
 * This is the main entry point for a fully autonomous session. It owns:
 * - KnowledgeGraph   → shared facts, goals, decisions, changes
 * - TaskDAG         → task dependency graph
 * - TaskAuctioneer  → project-wide task marketplace
 * - ConsensusProtocol → agent voting on changes
 * - ChangeManager   → change lifecycle
 * - AutonomousBrain  → LLM-backed decision-making
 * - FleetManager    → subagent lifecycle (spawn/assign/await)
 *
 * ## Self-directing loop
 *
 * The coordinator runs a goal-oriented loop:
 *
 * 1. Brain decides: what needs to be done?
 * 2. Goals are published to the KnowledgeGraph
 * 3. TaskAuctioneer broadcasts them → idle agents bid → winner claims
 * 4. Agent works autonomously, updating goal status
 * 5. On completion: facts are published, next goals unblock
 * 6. For code changes: ConsensusProtocol votes → ChangeManager applies
 * 7. Brain reviews outcomes → self-improves
 *
 * ## Cross-session coordination
 *
 * Everything is backed by JSONL files under `sessionDir/_autonomous/`.
 * Agents in different terminal sessions (TUI, WebUI, REPL) on the same
 * project share the same KnowledgeGraph, TaskDAG, and Mailbox — they see
 * each other's tasks, bids, and results in real time.
 *
 * @module autonomous-coordinator
 */
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { FleetBus, FleetEvent } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { Mailbox } from './mailbox-types.js';
import type {
  FactNode,
  GoalNode,
  FactCategory,
  GoalPriority,
} from './knowledge-graph.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { TaskDAG, type DAGEdgeEvent } from './task-dag.js';
import { TaskAuctioneer } from './task-auctioneer.js';
import { ConsensusProtocol } from './consensus-protocol.js';
import { ChangeManager, DEFAULT_QUALITY_CHECKS } from './change-manager.js';
import { AutonomousBrain, type LLMProvider } from './autonomous-brain.js';

export interface AutonomousCoordinatorOptions {
  sessionDir: string;
  selfAgentId: string;
  selfAgentName: string;
  fleet?: FleetBus | undefined;
  fleetManager?: FleetManager | undefined;
  mailbox?: Mailbox | undefined;
  events?: EventBus | undefined;
  llmProvider: LLMProvider;
  /** Disable self-improvement. Default: false. */
  disableSelfImprove?: boolean;
  /** Max concurrent subagents. Default: 5. */
  maxConcurrentAgents?: number;
  /**
   * Called with every CoordinatorEvent so the caller (e.g. execution.ts)
   * can forward it to the TUI coordinator panel timeline.
   */
  onCoordinatorEvent?: (event: CoordinatorEvent) => void;
}

export interface RunOptions {
  /** Top-level goal description. Default: "Improve the codebase". */
  goal?: string;
  /** If true, the loop runs until all goals are done (no timeout). Default: false. */
  runUntilComplete?: boolean;
  /** Max iterations. Default: 100. */
  maxIterations?: number;
  /** Stop if cost exceeds this. Default: no limit. */
  maxCostUsd?: number;
}

export interface CoordinatorStats {
  goals: { total: number; done: number; pending: number; failed: number; progress: number };
  dag: ReturnType<TaskDAG['stats']>;
  auction: ReturnType<TaskAuctioneer['getStats']>;
  changes: { proposed: number; approved: number; applied: number; rejected: number };
  decisions: number;
  costSoFar?: number | undefined;
}

/**
 * AutonomousCoordinator — wires all coordination components into one engine.
 *
 * ## Quick start
 *
 * ```typescript
 * const coord = new AutonomousCoordinator({
 *   sessionDir: '/tmp/session',
 *   selfAgentId: 'director-1',
 *   selfAgentName: 'Director',
 *   llmProvider: myLLMProvider,
 *   fleet: myFleetBus,
 *   mailbox: myMailbox,
 * });
 *
 * // Run a self-directing session
 * await coord.run({ goal: 'Audit and fix all security issues in the auth module' });
 * ```
 */
export class AutonomousCoordinator {
  readonly graph: KnowledgeGraph;
  readonly dag: TaskDAG;
  readonly auction: TaskAuctioneer;
  readonly consensus: ConsensusProtocol;
  readonly changes: ChangeManager;
  readonly brain: AutonomousBrain;

  private readonly selfAgentId: string;
  private readonly fleet?: FleetBus | undefined;
  private readonly fleetManager?: FleetManager | undefined;
  private readonly mailbox?: Mailbox | undefined;
  private readonly events?: EventBus | undefined;
  private readonly onCoordinatorEvent?: ((event: CoordinatorEvent) => void) | undefined;

  private running = false;
  private iterationCount = 0;
  /** Tasks already handled by _onSubagentTerminated (to avoid double goal:failed on fleet event). */
  private readonly _handledBySubagent = new Set<string>();

  constructor(opts: AutonomousCoordinatorOptions) {
    this.selfAgentId = opts.selfAgentId;
    this.fleet = opts.fleet ?? undefined;
    this.fleetManager = opts.fleetManager ?? undefined;
    this.mailbox = opts.mailbox ?? undefined;
    this.events = opts.events ?? undefined;
    this.onCoordinatorEvent = opts.onCoordinatorEvent;

    // ── Core shared state ─────────────────────────────────────────────
    this.graph = new KnowledgeGraph(opts.sessionDir);

    // ── Task dependency graph ─────────────────────────────────────────
    this.dag = new TaskDAG();

    // ── Task marketplace ────────────────────────────────────────────────
    this.auction = new TaskAuctioneer({
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      mailbox: this.mailbox ?? undefined,
      selfAgentId: this.selfAgentId,
    });

    // ── Consensus protocol ─────────────────────────────────────────────
    this.consensus = new ConsensusProtocol({
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      voters: this._buildVoters(),
      rules: {
        quorumFraction: 0.5,
        approvalFraction: 0.6,
        vetoRoles: ['critic'], // Critic has veto power
        approvalWeightFraction: 0.5,
      },
    });

    // ── Change manager ─────────────────────────────────────────────────
    this.changes = new ChangeManager({
      graph: this.graph,
      consensus: this.consensus,
      fleet: this.fleet ?? undefined,
      checks: DEFAULT_QUALITY_CHECKS,
    });

    // ── Brain ─────────────────────────────────────────────────────────
    this.brain = new AutonomousBrain({
      llmProvider: opts.llmProvider,
      graph: this.graph,
      fleet: this.fleet ?? undefined,
      selfImprove: !opts.disableSelfImprove,
    });

    // ── Wire DAG events to auction ──────────────────────────────────────
    this.dag.onEvent((event: DAGEdgeEvent) => {
      this._onDagEvent(event);
    });

    // ── Wire fleet events ───────────────────────────────────────────────
    // NOTE: 'subagent.terminated' is never emitted — '_onSubagentTerminated' was
    // dead code. The correct event is 'subagent.completed' (emitted by
    // MultiAgentCoordinator when a subagent finishes with status).
    this.fleet?.filter('subagent.completed', (e: FleetEvent) => {
      this._onSubagentTerminated(e);
    });

    // Wire task:failed from auctioneer — emits goal:failed for orphan tasks
    // (subagent terminations are handled separately in _onSubagentTerminated)
    this.fleet?.filter('task:failed', (e: FleetEvent) => {
      const payload = e.payload as { taskId: string; error: string } | undefined;
      const taskId = payload?.taskId;
      if (!taskId || this._handledBySubagent.has(taskId)) return;
      this._handledBySubagent.add(taskId);
      this._emit({ type: 'goal:failed', goalId: taskId, text: payload?.error ?? 'Task failed' });
    });
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Run the autonomous loop until the goal is satisfied or max iterations reached.
   * This is the main entry point for a fully autonomous session.
   */
  async run(opts: RunOptions = {}): Promise<CoordinatorStats> {
    if (this.running) throw new Error('AutonomousCoordinator: already running');
    this.running = true;
    this.iterationCount = 0;

    const maxIterations = opts.maxIterations ?? 100;
    const goal = opts.goal ?? 'Improve the codebase';
    const maxCost = opts.maxCostUsd;

    try {
      // Load persisted state (inside try so errors are caught)
      await this.graph.load();

      // Phase 1: Decompose the goal into sub-goals
      const goalConfigs = await this._decomposeGoal(goal);
      for (const g of goalConfigs) {
        const goalId = await this.auction.publishTask(g);
        this._emit({ type: 'goal:added', goalId, title: g.title, text: g.description });
      }

      // Phase 2: Run the autonomous loop
      while (this.running) {
        this.iterationCount++;

        // Check exit conditions
        if (this.iterationCount >= maxIterations) break;
        if (maxCost !== undefined) {
          const cost = this.fleetManager?.snapshot()?.total?.cost ?? 0;
          if (cost >= maxCost) break;
        }
        if (opts.runUntilComplete && this.dag.isDone()) break;

        // Decide: what to work on next?
        const decision = await this.brain.decideAuto({
          id: randomUUID(),
          source: 'system',
          decisionType: 'prioritize_goals',
          question: `What should we work on next? Open goals: ${this.auction.getPendingTasks().map((g) => g.title).join(', ') || 'none'}`,
          context: {
            goals: this.auction.getPendingTasks(),
            fleetStatus: this._fleetStatus(),
          },
          options: this._goalToOptions(this.auction.getPendingTasks()),
          risk: 'medium',
          requiresConsensus: false,
        });

        if (decision.type === 'deny') {
          // No clear direction — check for blocked goals
          const blocked = this.dag.getBlocked();
          if (blocked.length > 0 && this.dag.hasDeadlock()) {
            (this.events?.emit as (type: string, payload: unknown) => void)('autonomous:deadlock', { blocked });
            this.running = false;
          }
          break;
        }

        // Handle ask_human — can't proceed autonomously, stop
        if (decision.type === 'ask_human') {
          (this.events?.emit as (type: string, payload: unknown) => void)('autonomous:ask_human', { prompt: decision.prompt });
          break;
        }

        // Process the next best goal (answer type)
        if (decision.optionId) {
          const goalNode = this._optionToGoal(decision.optionId);
          if (goalNode) {
            await this._processGoal(goalNode.id);
          }
        }

        // Check for pending changes that need consensus
        const pendingChanges = this.changes.getPendingReviews();
        for (const change of pendingChanges) {
          await this._handlePendingChange(change);
        }
      }
    } finally {
      this.running = false;
    }

    return this.getStats();
  }

  /** Stop the autonomous loop. */
  stop(): void {
    this.running = false;
  }

  /** Get a stats snapshot. */
  getStats(): CoordinatorStats {
    const dagStats = this.dag.stats();
    const auctionStats = this.auction.getStats();
    const allGoals = this.graph.getGoals({});
    const allChanges = this.graph.getChanges({});
    const allDecisions = this.graph.getDecisions();

    return {
      goals: {
        total: allGoals.length,
        done: allGoals.filter((g) => g.status === 'done').length,
        pending: allGoals.filter((g) => g.status === 'pending').length,
        failed: allGoals.filter((g) => g.status === 'failed').length,
        progress: allGoals.length > 0
          ? allGoals.filter((g) => g.status === 'done').length / allGoals.length
          : 0,
      },
      dag: dagStats,
      auction: auctionStats,
      changes: {
        proposed: allChanges.filter((c) => c.status === 'proposed').length,
        approved: allChanges.filter((c) => c.status === 'approved').length,
        applied: allChanges.filter((c) => c.status === 'applied').length,
        rejected: allChanges.filter((c) => c.status === 'rejected').length,
      },
      decisions: allDecisions.length,
      costSoFar: this.fleetManager?.snapshot()?.total?.cost,
    };
  }

  // ── Fact publishing ──────────────────────────────────────────────────

  /**
   * Publish a fact discovered by an agent. Facts are immutable and form
   * the basis for other agents' decisions.
   */
  async publishFact(input: {
    category: FactCategory;
    subject: string;
    detail: string;
    file?: string;
    line?: number;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    tags?: string[];
  }): Promise<FactNode> {
    const fact = await this.graph.add({
      type: 'fact',
      category: input.category,
      subject: input.subject,
      detail: input.detail,
      file: input.file,
      line: input.line,
      severity: input.severity,
      discoveredBy: this.selfAgentId,
      discoveredAt: new Date().toISOString(),
      tags: input.tags ?? [],
      key: `${input.category}:${input.subject}:${input.file ?? ''}:${input.line ?? ''}`,
      related: [],
    } as Omit<FactNode, 'id'>) as FactNode;

    // Cross-session broadcast
    await this._mailboxBroadcast({
      type: 'note',
      subject: `[${input.severity ?? 'info'}] ${input.category}: ${input.subject}`,
      body: `**${input.category}**${input.file ? ` in ${input.file}${input.line ? `:${input.line}` : ''}` : ''}\n${input.detail}`,
    });

    this._emit({ type: 'knowledge:added', knowledgeId: fact.id, title: input.subject, text: input.detail });

    return fact;
  }

  // ── Goal creation helpers ────────────────────────────────────────────

  /**
   * Publish a goal and add it to the DAG.
   */
  async createGoal(input: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    deps?: string[];
    tags?: string[];
  }): Promise<GoalNode> {
    const resolvedPriority: GoalPriority = input.priority ?? 'medium';
    const goalId = await this.auction.publishTask({
      title: input.title,
      description: input.description,
      priority: resolvedPriority,
      ...(input.tags ? { tags: input.tags } : {}),
    });

    const goal = this.graph.get(goalId) as GoalNode;

    // Add to DAG
    for (const depId of input.deps ?? []) {
      this.dag.addNode(depId, this.graph.get(depId)?.type === 'goal'
        ? (this.graph.get(depId) as GoalNode).title
        : depId);
    }
    this.dag.addNode(goalId, input.description, input.deps ?? []);

    return goal;
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async _decomposeGoal(goalText: string): Promise<{
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    tags?: string[];
  }[]> {
    const category = this._inferCategory(goalText);

    const subGoals: {
      title: string;
      description: string;
      priority?: 'critical' | 'high' | 'medium' | 'low';
      tags?: string[];
    }[] = [];

    if (category === 'security') {
      subGoals.push({ title: 'Audit for secrets', description: 'Scan codebase for hardcoded secrets and API keys', priority: 'critical', tags: ['security'] });
      subGoals.push({ title: 'Check injection vectors', description: 'Find eval, innerHTML, SQL concat, shell injection patterns', priority: 'critical', tags: ['security', 'injection'] });
      subGoals.push({ title: 'Dependency audit', description: 'Run npm/pnpm audit for known CVEs', priority: 'high', tags: ['security', 'deps'] });
    } else if (category === 'bug') {
      subGoals.push({ title: 'Find bugs', description: `Scan for bugs related to: ${goalText}`, priority: 'high', tags: ['bug'] });
      subGoals.push({ title: 'Fix bugs', description: 'Fix discovered bugs with tests', priority: 'high', tags: ['fix'] });
    } else if (category === 'refactor') {
      subGoals.push({ title: 'Plan refactor', description: `Analyze code structure for: ${goalText}`, priority: 'medium', tags: ['refactor', 'planning'] });
      subGoals.push({ title: 'Implement refactor', description: 'Apply the refactoring plan', priority: 'medium', tags: ['refactor', 'implementation'] });
    } else {
      subGoals.push({ title: goalText, description: goalText, priority: 'medium', tags: [category] });
    }

    return subGoals;
  }

  private _inferCategory(goal: string): FactCategory {
    const g = goal.toLowerCase();
    if (g.includes('security') || g.includes('secret') || g.includes('injection')) return 'security';
    if (g.includes('bug') || g.includes('fix') || g.includes('error')) return 'bug';
    if (g.includes('refactor') || g.includes('debt') || g.includes('architecture')) return 'architecture';
    if (g.includes('test') || g.includes('coverage')) return 'test';
    if (g.includes('perf') || g.includes('speed') || g.includes('optimize')) return 'perf';
    if (g.includes('deps') || g.includes('package') || g.includes('update')) return 'deps';
    return 'quality';
  }

  private async _processGoal(goalId: string): Promise<void> {
    // The DAG handles dependency ordering
    const ready = this.dag.getReady();
    if (ready.length === 0) return;

    const next = ready.find((n) => n.id === goalId) ?? ready[0]!;
    this.dag.start(next.id, 'auctioneer');

    // Check if an agent is already working on this
    const existingAgent = this.auction.getTasksForAgent(this.selfAgentId)
      .find((g) => g.id === next.id);

    if (!existingAgent) {
      // Publish to the auction
      const taskId = await this.auction.publishTask({
        title: next.description,
        description: next.description,
        priority: this._dagPriorityToGoal(next.priority),
        tags: next.tags,
      });
      this._emit({ type: 'task:ready', goalId, taskId, title: next.description });
    }

    // Wait for the task to be claimed
    await this._waitForClaim(next.id);
  }

  private async _waitForClaim(taskId: string): Promise<void> {
    // Poll until the task is claimed (status = in_progress) or done
    const maxWait = 60_000; // 60s
    const pollInterval = 2_000; // 2s
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const goal = this.graph.get(taskId) as GoalNode | undefined;
      if (goal?.status === 'in_progress' || goal?.status === 'done') {
        return;
      }
      await this._sleep(pollInterval);
    }
  }

  private async _handlePendingChange(change: { id: string; qualityGate: { passed: boolean; checks: { name: string }[] } }): Promise<void> {
    const result = this.consensus.getStatus(change.id);
    if (result?.outcome !== 'pending') return;

    // Auto-vote if we have quality gate results
    if (change.qualityGate.passed) {
      const voteResult = await this.consensus.castVote(change.id, this.selfAgentId, 'approve',
        `Quality gate passed: ${change.qualityGate.checks.map((c) => c.name).join(', ')}`);
      if (voteResult.outcome === 'approved') {
        await this.changes.markApplied(change.id, new Date().toISOString());
        this._emit({ type: 'consensus:reached', goalId: change.id, text: 'Change approved and applied' });
      }
    }
  }

  private _onDagEvent(event: DAGEdgeEvent): void {
    if (event.type === 'node:ready') {
      // A new task became runnable — broadcast it
      const node = this.dag.getNode(event.nodeId);
      if (node) {
        (this.events?.emit as (type: string, payload: unknown) => void)('autonomous:task_ready', { taskId: event.nodeId, description: node.description });
      }
    }
    if (event.type === 'deadlock') {
      (this.events?.emit as (type: string, payload: unknown) => void)('autonomous:deadlock', { blocked: event.blocked });
      this._emit({ type: 'deadlock:detected', goalId: event.blocked[0] ?? '', text: `Deadlock detected: ${event.blocked.join(', ')}` });
      this.running = false;
    }
    if (event.type === 'graph:done') {
      (this.events?.emit as (type: string, payload: unknown) => void)('autonomous:all_done', this.getStats());
    }
  }

  private _onSubagentTerminated(e: FleetEvent): void {
    // Handle both the old 'stopReason' format and the 'subagent.completed' format
    const payload = e.payload as {
      subagentId?: string;
      stopReason?: string;
      status?: 'ok' | 'error' | 'timeout' | 'aborted';
      taskId?: string;
    } | undefined;
    const subagentId = payload?.subagentId ?? e.subagentId;
    // 'stopReason' is from the old format; 'status' is from 'subagent.completed'
    const stopReason = payload?.stopReason ?? (payload?.status === 'ok' ? 'end_turn' : (payload?.status ?? 'unknown'));
    const tasks = this.auction.getTasksForAgent(subagentId);

    for (const task of tasks) {
      this._handledBySubagent.add(task.id); // prevent double-emission when fleet fires task:failed
      if (stopReason === 'end_turn') {
        void this.auction.complete(task.id, 'Subagent completed successfully');
        this._emit({ type: 'task:completed', goalId: task.id, taskId: task.id, text: 'Subagent completed successfully' });
      } else {
        void this.auction.fail(task.id, `Subagent terminated: ${stopReason}`);
        this._emit({ type: 'goal:failed', goalId: task.id, text: `Subagent terminated: ${stopReason}` });
      }
    }
  }

  private _fleetStatus() {
    return {
      running: this.fleetManager?.getFleetStats().running ?? 0,
      idle: this.fleetManager?.getFleetStats().idle ?? 0,
      total: this.fleetManager?.getFleetStats().total ?? 0,
      costSoFar: this.fleetManager?.snapshot()?.total?.cost ?? 0,
    };
  }

  private _buildVoters() {
    return [
      { agentId: 'critic', agentName: 'Critic', role: 'critic', weight: 2, veto: true },
      { agentId: 'bug-hunter', agentName: 'Bug Hunter', role: 'bug-hunter', weight: 1.5 },
      { agentId: 'security-scanner', agentName: 'Security Scanner', role: 'security-scanner', weight: 1.5 },
      { agentId: 'audit-log', agentName: 'Audit Log', role: 'audit-log', weight: 1 },
      { agentId: 'refactor-planner', agentName: 'Refactor Planner', role: 'refactor-planner', weight: 1 },
    ];
  }

  private _goalToOptions(goals: GoalNode[]): { id: string; label: string; recommended?: boolean }[] {
    return goals.slice(0, 5).map((g, i) => ({
      id: g.id,
      label: `[${g.priority}] ${g.title}`,
      recommended: i === 0,
    }));
  }

  private _optionToGoal(optionId: string): GoalNode | undefined {
    return this.graph.get(optionId) as GoalNode | undefined;
  }

  private _dagPriorityToGoal(p: number): 'critical' | 'high' | 'medium' | 'low' {
    if (p <= 1) return 'critical';
    if (p <= 2) return 'high';
    if (p <= 4) return 'medium';
    return 'low';
  }

  private async _mailboxBroadcast(msg: { type: 'note' | 'broadcast'; subject: string; body: string }): Promise<void> {
    if (!this.mailbox) return;
    try {
      await this.mailbox.send({
        from: this.selfAgentId,
        to: '*',
        type: msg.type,
        subject: msg.subject,
        body: msg.body,
        priority: 'normal',
      });
    } catch { /* best-effort */ }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Emit a CoordinatorEvent to the subscriber (e.g. TUI panel timeline). */
  private _emit(event: CoordinatorEvent): void {
    this.onCoordinatorEvent?.(event);
  }
}
