import type { WebSocket } from 'ws';
import type { SddInterviewDriver, SddInterviewSnapshot } from '@wrongstack/core';

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface WizardMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/** Short, single-line heading derived from a (possibly long) goal prompt. */
function deriveTitle(goal: string): string {
  const firstLine = goal
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return 'New SDD Project';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`;
}

/**
 * Dependencies each webui server supplies. The handler is deliberately
 * agent-agnostic: every surface decides how to build a driver, how to run an
 * interview turn (on an isolated agent, off the main chat bus), and how to
 * start the real multi-agent run (CLI's director-backed factory vs the runtime
 * light factory). This keeps the wizard protocol identical across both servers.
 */
export interface SddWizardDeps {
  /** Build a fresh interview driver (disk spec/graph stores + session path). */
  makeDriver: () => SddInterviewDriver;
  /**
   * Run one interview turn: feed the AI prompt to an isolated agent and return
   * its final text. MUST NOT run on the main chat agent's bus — the wizard owns
   * this conversation, separate from the user's chat.
   */
  runInterviewTurn: (prompt: string) => Promise<string>;
  /**
   * Start the real multi-agent SDD run for the driver's task graph. Returns the
   * runId; the live board flows through the existing board handler.
   */
  startRun: (
    driver: SddInterviewDriver,
    opts: {
      parallelSlots?: number | undefined;
      defaultModel?: string | undefined;
      defaultProvider?: string | undefined;
      fallbackModels?: string[] | undefined;
    },
  ) => Promise<{ runId: string }>;
}

/**
 * SddWizardWebSocketHandler — drives the interactive "New SDD Project" wizard
 * (goal → Q&A → spec → task graph → start run) over WebSocket. Shared by both
 * webui servers; server-specific construction (agent, factory) is injected via
 * {@link SddWizardDeps}.
 */
export class SddWizardWebSocketHandler {
  private readonly clients = new Set<WSClient>();
  private driver: SddInterviewDriver | null = null;
  /** The agent's most recent question — paired with the next user answer. */
  private lastAgentText = '';
  /** Guards against overlapping interview turns (one in flight at a time). */
  private busy = false;

  constructor(private readonly deps: SddWizardDeps) {}

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    // Send the current interview state (if any) so a reconnecting client catches up.
    if (this.driver) this.send(client, this.snapshotMsg());
  }

  async handleMessage(msg: WizardMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'sdd.spec.start':
          await this.onStart(String(msg.payload?.goal ?? '').trim());
          break;
        case 'sdd.spec.message':
          await this.onMessage(String(msg.payload?.text ?? ''));
          break;
        case 'sdd.spec.approve':
          await this.onApprove();
          break;
        case 'sdd.spec.get':
          if (this.driver) this.broadcast(this.snapshotMsg());
          break;
        case 'sdd.run.start':
          await this.onRunStart({
            parallelSlots: msg.payload?.parallelSlots as number | undefined,
            defaultModel: msg.payload?.model as string | undefined,
            defaultProvider: msg.payload?.provider as string | undefined,
            fallbackModels: Array.isArray(msg.payload?.fallbackModels)
              ? (msg.payload?.fallbackModels as string[])
              : undefined,
          });
          break;
      }
    } catch (err) {
      this.busy = false;
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ── message handlers ──────────────────────────────────────────────────────

  private async onStart(goal: string): Promise<void> {
    if (!goal) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'A goal is required.' } });
      return;
    }
    if (this.busy) return;
    this.driver = this.deps.makeDriver();
    // Keep the operator's full prompt as the interview's intent/goal, but give
    // the session a short readable title — pasting the whole prompt as the title
    // made the wizard header unreadable.
    const prompt = this.driver.start(deriveTitle(goal), goal);
    await this.runTurn(prompt);
  }

  private async onMessage(text: string): Promise<void> {
    if (!this.driver || this.busy) return;
    // In the questioning phase, the user's message answers the agent's last
    // question. In review phases a free-form message is fed back as context.
    if (this.driver.phase() === 'questioning' && this.lastAgentText) {
      this.driver.submitAnswer(this.lastAgentText, text);
    } else {
      this.driver.submitAnswer(this.lastAgentText || '(feedback)', text);
    }
    await this.runTurn(this.driver.currentPrompt());
  }

  private async onApprove(): Promise<void> {
    if (!this.driver || this.busy) return;
    const { phase, prompt } = await this.driver.approve();
    // Executing phase needs no further AI turn — the graph is ready to run.
    if (phase === 'executing') {
      this.broadcast(this.snapshotMsg());
      return;
    }
    await this.runTurn(prompt);
  }

  private async onRunStart(opts: {
    parallelSlots?: number | undefined;
    defaultModel?: string | undefined;
    defaultProvider?: string | undefined;
    fallbackModels?: string[] | undefined;
  }): Promise<void> {
    if (!this.driver) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'No active spec session.' } });
      return;
    }
    // Guarantee a graph exists (deterministic fallback if the agent never
    // emitted a task array).
    const graph = await this.driver.ensureTaskGraph();
    if (!graph) {
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: 'No spec yet — finish the interview before starting a run.' },
      });
      return;
    }
    const { runId } = await this.deps.startRun(this.driver, opts);
    this.broadcast({ type: 'sdd.run.started', payload: { runId } });
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Run one interview turn against the isolated agent, then ingest + broadcast. */
  private async runTurn(prompt: string): Promise<void> {
    this.busy = true;
    this.broadcast(this.snapshotMsg());
    try {
      const text = await this.deps.runInterviewTurn(prompt);
      this.lastAgentText = text;
      if (this.driver) await this.driver.ingestAgentOutput(text);
      this.broadcast({ type: 'sdd.spec.agent_text', payload: { text } });
    } finally {
      this.busy = false;
      this.broadcast(this.snapshotMsg());
    }
  }

  private snapshotMsg(): { type: string; payload: SddInterviewSnapshot & { busy: boolean } } {
    const snap = this.driver?.snapshot();
    return {
      type: 'sdd.spec.snapshot',
      payload: { ...(snap as SddInterviewSnapshot), busy: this.busy },
    };
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === 1) client.ws.send(data);
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }
}
