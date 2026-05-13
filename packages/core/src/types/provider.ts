import type { ContentBlock, TextBlock } from './blocks.js';
import type { Message } from './messages.js';
import type { Tool } from './tool.js';

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface Capabilities {
  tools: boolean;
  parallelTools: boolean;
  vision: boolean;
  streaming: boolean;
  promptCache: boolean;
  systemPrompt: boolean;
  jsonMode: boolean;
  maxContext: number;
  cacheControl: 'native' | 'auto' | 'none';
}

export interface Request {
  model: string;
  system?: TextBlock[];
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; name: string };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface Response {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
}

export type StreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'content_block_start'; kind: 'text' | 'tool_use'; id?: string; name?: string }
  | { type: 'content_block_stop'; index: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partial: string }
  | { type: 'tool_use_stop'; id: string; input: unknown }
  | { type: 'message_stop'; stopReason: StopReason; usage: Usage };

export interface Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  /** Canonical streaming entry point. `complete()` defaults to a wrapper that
   * aggregates this stream — providers may override for non-streaming wires. */
  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent>;
  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response>;
}

export class ProviderError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly providerId: string;
  public override readonly cause?: unknown;

  constructor(message: string, status: number, retryable: boolean, providerId: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.providerId = providerId;
    this.cause = cause;
  }
}
