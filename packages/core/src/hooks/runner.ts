import type { HookEntry, HookEvent, HookInput, HookOutcome } from '../types/hooks.js';
import type { Logger } from '../types/logger.js';
import { type HookRegistry, hookMatcherMatches } from './registry.js';
import { runShellHook } from './shell-executor.js';
import { toErrorMessage } from '../utils/error.js';

/** Minimal run-state the runner reads. `Context` structurally satisfies it. */
export interface HookRunEnv {
  cwd: string;
}

export interface HookRunnerOptions {
  registry: HookRegistry;
  logger?: Logger | undefined;
  /**
   * When false, shell hooks are skipped entirely (in-process hooks still run).
   * Set by the boot path under `--bare` / `--no-hooks` / untrusted sessions.
   */
  allowShell?: boolean | undefined;
  /** Resolves the active session id for the `HookInput` payload. */
  sessionId?: ((() => string)) | undefined;
}

export interface PreToolUseResult {
  block?: boolean | undefined;
  reason?: string | undefined;
  /** Present only when a hook replaced the tool input. */
  input?: Record<string, unknown>;
}

export interface PromptResult {
  block?: boolean | undefined;
  reason?: string | undefined;
  additionalContext?: string | undefined;
}

/**
 * Drives the registered hooks at each lifecycle phase. Pure orchestration —
 * the executor / pipeline / agent extension call the matching method and act on
 * the returned decision. Hook failures are caught and logged; they never abort
 * the agent.
 */
export class HookRunner {
  private readonly registry: HookRegistry;

  constructor(private readonly opts: HookRunnerOptions) {
    this.registry = opts.registry;
  }

  /** Cheap guard so callers can skip building payloads when nothing listens. */
  has(event: HookEvent): boolean {
    return this.registry.has(event);
  }

  async preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    env: HookRunEnv,
  ): Promise<PreToolUseResult> {
    const entries = this.matching('PreToolUse', toolName);
    if (entries.length === 0) return {};
    let current = toolInput;
    let mutated = false;
    for (const entry of entries) {
      const payload: HookInput = {
        event: 'PreToolUse',
        toolName,
        toolInput: current,
        ...this.base(env),
      };
      const outcome = await this.invoke(entry, payload);
      if (!outcome) continue;
      if (outcome.modifiedInput && typeof outcome.modifiedInput === 'object') {
        current = outcome.modifiedInput;
        mutated = true;
      }
      if (outcome.decision === 'block') {
        return { block: true, reason: outcome.reason ?? `Blocked by ${entry.event} hook` };
      }
    }
    return mutated ? { input: current } : {};
  }

  async postToolUse(
    toolName: string,
    toolInput: unknown,
    result: { content: string; isError: boolean },
    env: HookRunEnv,
  ): Promise<{ additionalContext?: string | undefined }> {
    const payload: HookInput = {
      event: 'PostToolUse',
      toolName,
      toolInput,
      toolResult: result,
      ...this.base(env),
    };
    return { additionalContext: await this.collectContext('PostToolUse', toolName, payload) };
  }

  async userPromptSubmit(prompt: string, env: HookRunEnv): Promise<PromptResult> {
    const entries = this.matching('UserPromptSubmit', undefined);
    if (entries.length === 0) return {};
    const payload: HookInput = { event: 'UserPromptSubmit', prompt, ...this.base(env) };
    const parts: string[] = [];
    for (const entry of entries) {
      const outcome = await this.invoke(entry, payload);
      if (!outcome) continue;
      if (outcome.decision === 'block') {
        return { block: true, reason: outcome.reason ?? 'Blocked by UserPromptSubmit hook' };
      }
      if (outcome.additionalContext) parts.push(outcome.additionalContext);
    }
    return parts.length ? { additionalContext: parts.join('\n') } : {};
  }

  async sessionStart(env: HookRunEnv): Promise<{ additionalContext?: string | undefined }> {
    const payload: HookInput = { event: 'SessionStart', ...this.base(env) };
    return { additionalContext: await this.collectContext('SessionStart', undefined, payload) };
  }

  async stop(env: HookRunEnv): Promise<void> {
    const payload: HookInput = { event: 'Stop', ...this.base(env) };
    await this.collectContext('Stop', undefined, payload);
  }

  // ── internals ──────────────────────────────────────────────────────

  private base(env: HookRunEnv): { cwd: string; sessionId?: string | undefined } {
    const sessionId = this.opts.sessionId?.();
    return sessionId ? { cwd: env.cwd, sessionId } : { cwd: env.cwd };
  }

  private matching(event: HookEvent, toolName: string | undefined): readonly HookEntry[] {
    return this.registry.list(event).filter((e) => hookMatcherMatches(e.matcher, toolName));
  }

  private async invoke(entry: HookEntry, payload: HookInput): Promise<HookOutcome | null> {
    try {
      if (entry.kind === 'inprocess') {
        const r = await entry.hook(payload);
        return r ?? null;
      }
      if (this.opts.allowShell === false) return null;
      return await runShellHook(
        { command: entry.command, timeoutMs: entry.timeoutMs },
        payload,
        this.opts.logger,
      );
    } catch (err) {
      this.opts.logger?.warn?.(
        `${payload.event} hook threw: ${toErrorMessage(err)}`,
      );
      return null;
    }
  }

  private async collectContext(
    event: HookEvent,
    toolName: string | undefined,
    payload: HookInput,
  ): Promise<string | undefined> {
    const entries = this.matching(event, toolName);
    if (entries.length === 0) return undefined;
    // Run all matching hooks in parallel — none mutate state or block;
    // each only returns additionalContext which is independently useful.
    const results = await Promise.allSettled(entries.map((entry) => this.invoke(entry, payload)));
    const parts: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.additionalContext) {
        parts.push(result.value.additionalContext);
      }
    }
    return parts.length ? parts.join('\n') : undefined;
  }
}
