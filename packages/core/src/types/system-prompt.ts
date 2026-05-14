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
  /** Currently active mode id (e.g. "debugger", "default"). */
  activeModeId?: string;
  /** Model capabilities for context-aware prompt composition. */
  capabilities?: ModelCapabilities;
}

export interface SystemPromptBuilder {
  build(ctx: BuildContext): Promise<TextBlock[]>;
}
