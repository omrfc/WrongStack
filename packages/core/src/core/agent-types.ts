/**
 * Agent type definitions — extracted from agent.ts to break circular
 * dependencies and keep the Agent class focused on runtime logic.
 */
import { Pipeline } from '../kernel/pipeline.js';
import { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { WrongStackError } from '../types/errors.js';
import type { Tracer } from '../types/observability.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Request, Response } from '../types/provider.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
import type { Context } from './context.js';

/** Default iteration cap. Use 0 or Infinity via config to disable. */
export const DEFAULT_MAX_ITERATIONS = 100;

export interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  error?: WrongStackError;
  finalText?: string;
  iterations: number;
  delegateSummaries?: Array<{ summary: string; ok: boolean }>;
}

export interface AgentInit {
  container: Container;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  events: EventBus;
  pipelines: AgentPipelines;
  context: Context;
  maxIterations?: number;
  iterationTimeoutMs?: number;
  executionStrategy?: 'parallel' | 'sequential' | 'smart';
  perIterationOutputCapBytes?: number;
  autoExtendLimit?: boolean;
  autonomousContinue?: boolean;
  confirmAwaiter?: import('../types/tool-executor.js').ConfirmAwaiter | undefined;
  permissionPolicy?: PermissionPolicy;
  tracer?: Tracer | undefined;
  extensions?: ExtensionRegistry | undefined;
  toolExecutor: ToolExecutorLike;
}

export interface AgentPipelines {
  request: Pipeline<Request>;
  response: Pipeline<Response>;
  toolCall: Pipeline<ToolCallPipelinePayload>;
  userInput: Pipeline<UserInputPayload>;
  assistantOutput: Pipeline<TextBlock>;
  contextWindow: Pipeline<Context>;
}

export interface UserInputPayload {
  content: ContentBlock[];
  text: string;
  ctx: Context;
}

export type AgentInput = string | ContentBlock[];

export function normalizeInput(input: AgentInput): { blocks: ContentBlock[]; text: string } {
  if (typeof input === 'string') {
    return { blocks: [{ type: 'text', text: input }], text: input };
  }
  const text = input.filter(isTextBlock).map((b) => b.text).join('');
  return { blocks: input, text };
}

export interface ToolCallPipelinePayload {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  ctx: Context;
  tool?: Tool;
}

export function createDefaultPipelines(): AgentPipelines {
  return {
    request: new Pipeline<Request>(),
    response: new Pipeline<Response>(),
    toolCall: new Pipeline<ToolCallPipelinePayload>(),
    userInput: new Pipeline<UserInputPayload>(),
    assistantOutput: new Pipeline<TextBlock>(),
    contextWindow: new Pipeline<Context>(),
  };
}
