import type { TextBlock } from './blocks.js';
import type { Tool } from './tool.js';

/** Model capabilities relevant to prompt composition. */
export interface ModelCapabilities {
  maxContextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export interface BuildContext {
  cwd: string;
  projectRoot: string;
  tools: Tool[];
  /** Provider id (e.g. "anthropic", "minimax-coding-plan"). */
  provider?: string;
  /** Model id (e.g. "claude-sonnet-4-6", "MiniMax-M2.7"). */
  model?: string;
  /**
   * True when the prompt is being built for a SUBAGENT, not the host
   * agent. Subagents are scoped to a single task — they should NOT see
   * the host's strategic plan board (which is anchoring the host across
   * turns, not steering individual subtasks). The plan-injection
   * layer short-circuits when this flag is set.
   */
  subagent?: boolean;
}

export interface SystemPromptBuilder {
  build(ctx: BuildContext): Promise<TextBlock[]>;
}
