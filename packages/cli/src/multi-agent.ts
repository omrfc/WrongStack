/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import { randomUUID } from 'node:crypto';
import {
  Agent,
  Container,
  Context,
  type Config,
  type ConfigStore,
  DefaultMultiAgentCoordinator,
  EventBus,
  makeAgentSubagentRunner,
  type MultiAgentCoordinator,
  type Provider,
  type ProviderRegistry,
  type SessionWriter,
  type SystemPromptBuilder,
  type TaskResult,
  type Tool,
  type ToolRegistry,
  type TokenCounter,
  TOKENS,
  createDefaultPipelines,
} from '@wrongstack/core';
import type { TextBlock } from '@wrongstack/core';
import { makeProviderFromConfig } from '@wrongstack/providers';

export interface MultiAgentDeps {
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  configStore: ConfigStore;
  events: EventBus;
  systemPromptBuilder: SystemPromptBuilder;
  session: SessionWriter;
  tokenCounter: TokenCounter;
  projectRoot: string;
  cwd: string;
}

/**
 * Lazy holder — created on first /spawn call, reused across the session
 * so /agents can list everyone running.
 */
export class MultiAgentHost {
  private coordinator?: MultiAgentCoordinator;
  private readonly pending = new Map<string, { description: string; subagentId: string }>();
  private readonly results: TaskResult[] = [];

  constructor(private readonly deps: MultiAgentDeps) {}

  private async ensureCoordinator(): Promise<MultiAgentCoordinator> {
    if (this.coordinator) return this.coordinator;
    const config: Config = this.deps.configStore.get() as Config;

    const factory = async (subCfg: { model?: string; tools?: string[] }) => {
      const events = new EventBus();
      const provider = await this.buildSubagentProvider(config);

      // Fresh context per subagent — explicit isolation.
      const baseSystem: TextBlock[] = await this.deps.systemPromptBuilder.build({
        cwd: this.deps.cwd,
        projectRoot: this.deps.projectRoot,
        tools: this.filterTools(subCfg.tools),
        model: subCfg.model ?? config.model,
        provider: config.provider,
      });

      // Reuse session id and append channel; subagent events get tagged
      // by source via the event bus rather than persisted to a separate
      // file. Keeps replay simple.
      const parentSession = this.deps.session;
      const subSession: SessionWriter = {
        id: parentSession.id,
        append: (ev) => parentSession.append({ ...ev }),
      } as SessionWriter;

      const ctx = new Context({
        systemPrompt: baseSystem,
        provider,
        session: subSession,
        // Placeholder — Agent.run() overwrites ctx.signal with the live
        // per-run signal (see core/agent.ts run()). Tools/middleware that
        // read ctx.signal after construction will see the runtime signal,
        // not this one. Kept as `new AbortController().signal` so the
        // initial value is non-null/non-aborted.
        signal: new AbortController().signal,
        tokenCounter: this.deps.tokenCounter,
        cwd: this.deps.cwd,
        projectRoot: this.deps.projectRoot,
        model: subCfg.model ?? config.model,
        tools: this.filterTools(subCfg.tools),
      });

      const agent = new Agent({
        container: this.deps.container,
        tools: this.subagentToolRegistry(subCfg.tools),
        providers: this.deps.providerRegistry,
        events,
        pipelines: createDefaultPipelines(),
        context: ctx,
      });

      return { agent, events };
    };

    const runner = makeAgentSubagentRunner({ factory });

    this.coordinator = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: randomUUID(),
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
        defaultBudget: { maxToolCalls: 20, maxIterations: 20, timeoutMs: 120_000 },
      },
      { runner },
    );

    // Drain task.completed into our local result buffer for /agents
    (this.coordinator as unknown as { on: Function }).on(
      'task.completed',
      ({ task, result }: { task: { id: string }; result: TaskResult }) => {
        this.results.push(result);
        this.pending.delete(task.id);
      },
    );

    return this.coordinator;
  }

  private async buildSubagentProvider(config: Config): Promise<Provider> {
    const newCfg = config.providers?.[config.provider] ?? {
      type: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    return makeProviderFromConfig(config.provider, {
      ...newCfg,
      type: config.provider,
    });
  }

  /** Returns a tool slice for the subagent — full set unless restricted. */
  private filterTools(allow?: string[]): Tool[] {
    const all = this.deps.toolRegistry.list();
    if (!allow || allow.length === 0) return all;
    const allowSet = new Set(allow);
    return all.filter((t) => allowSet.has(t.name));
  }

  private subagentToolRegistry(allow?: string[]): ToolRegistry {
    if (!allow || allow.length === 0) return this.deps.toolRegistry;
    // Build a filtered registry by cloning entries.
    const cloneCtor = this.deps.toolRegistry.constructor as new () => ToolRegistry;
    const sub = new cloneCtor();
    for (const t of this.filterTools(allow)) sub.register(t);
    return sub;
  }

  /** Spawn a fresh subagent and assign a single task. Returns task id. */
  async spawn(description: string): Promise<{ subagentId: string; taskId: string }> {
    const coord = await this.ensureCoordinator();
    const spawned = await coord.spawn({
      name: 'adhoc',
      role: 'general',
      maxToolCalls: 20,
      maxIterations: 20,
    });
    const taskId = randomUUID();
    this.pending.set(taskId, { description, subagentId: spawned.subagentId });
    await coord.assign({
      id: taskId,
      description,
      subagentId: spawned.subagentId,
      maxToolCalls: 20,
    });
    return { subagentId: spawned.subagentId, taskId };
  }

  status(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    completed: TaskResult[];
    summary: string;
  } {
    const pending = Array.from(this.pending.entries()).map(([taskId, v]) => ({
      taskId,
      description: v.description,
      subagentId: v.subagentId,
    }));
    const summary = !this.coordinator
      ? 'No subagents have been spawned.'
      : `${pending.length} pending, ${this.results.length} completed.`;
    return { pending, completed: this.results, summary };
  }

  async stopAll(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stopAll();
    }
  }
}
// Workaround: TOKENS reference satisfies unused-import lint without being
// active runtime usage — included for clarity that the coordinator
// shares the container's permission policy etc. via the agent factory.
void TOKENS;
