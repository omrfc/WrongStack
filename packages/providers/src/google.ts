import type {
  Capabilities,
  Message,
  Request,
  StreamEvent,
  StopReason,
  Tool,
  Usage,
} from '@wrongstack/core';
import { ProviderError, safeParse } from '@wrongstack/core';
import { parseProviderHttpError } from './error-parse.js';
import { normalizeOpenAI } from './stop-reason.js';
import { parseSSE } from './sse.js';
import { WireAdapter } from './wire-adapter.js';

/**
 * Google Gemini wire format (generativelanguage.googleapis.com).
 *
 * Differences vs OpenAI:
 *   - Endpoint includes the model in the path: /v1beta/models/{model}:generateContent
 *   - Messages → `contents: [{ role: 'user'|'model', parts: [...] }]`
 *   - System prompt → `systemInstruction: { parts: [{ text }] }`
 *   - Tools → `tools: [{ functionDeclarations: [...] }]`
 *   - Tool call → `parts: [{ functionCall: { name, args } }]`
 *   - Tool result → `parts: [{ functionResponse: { name, response } }]`
 *   - Auth via `?key=` query param or `x-goog-api-key` header
 */

export interface GoogleProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  id?: string;
  capabilities?: Partial<Capabilities>;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content?: unknown } };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

export class GoogleProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private readonly opts: GoogleProviderOptions;

  constructor(opts: GoogleProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl);
    this.opts = opts;
    this.id = opts.id ?? 'google';
    this.capabilities = {
      tools: true,
      parallelTools: true,
      vision: true,
      streaming: true,
      promptCache: false,
      systemPrompt: true,
      jsonMode: true,
      maxContext: 1_000_000,
      cacheControl: 'none',
      ...opts.capabilities,
    };
  }

  protected override buildUrl(req: Request): string {
    return `${this.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      'x-goog-api-key': this.apiKey,
    };
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: messagesToGemini(req.messages),
      generationConfig: this.buildGenConfig(req),
    };
    if (req.system && req.system.length > 0) {
      body['systemInstruction'] = {
        parts: req.system.map((b) => ({ text: b.text })),
      };
    }
    if (req.tools && req.tools.length > 0) {
      body['tools'] = [{ functionDeclarations: toolsToGemini(req.tools) }];
    }
    return body;
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseGoogleStream(body, fallbackModel);
  }

  protected override translateError(status: number, text: string): ProviderError {
    return parseProviderHttpError(this.id, status, text);
  }

  private buildGenConfig(req: Request): Record<string, unknown> {
    const cfg: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
    if (req.temperature !== undefined) cfg['temperature'] = req.temperature;
    if (req.topP !== undefined) cfg['topP'] = req.topP;
    if (req.stopSequences) cfg['stopSequences'] = req.stopSequences;
    return cfg;
  }
}

function toolsToGemini(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }));
}

function messagesToGemini(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          parts.push({ functionCall: { name: b.name, args: b.input } });
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    const textParts: GeminiPart[] = [];
    const functionParts: GeminiPart[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) textParts.push({ text: b.text });
      else if (b.type === 'tool_result') {
        const responseText =
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        // Prefer the canonical name field; fall back to tool_use_id for
        // blocks that were manually constructed (e.g. in tests).
        const fnName = b.name ?? b.tool_use_id;
        functionParts.push({
          functionResponse: {
            name: fnName,
            response: { content: responseText },
          },
        });
      } else if (b.type === 'image' && b.source.type === 'base64') {
        textParts.push({
          inlineData: {
            mimeType: b.source.media_type ?? 'image/png',
            data: b.source.data ?? '',
          },
        });
      }
    }
    if (textParts.length > 0) out.push({ role: 'user', parts: textParts });
    if (functionParts.length > 0) out.push({ role: 'function', parts: functionParts });
  }
  return out;
}

type Response2Body = ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;

/**
 * Translate Gemini's `:streamGenerateContent?alt=sse` wire format into
 * canonical StreamEvent[]. Each chunk is a full `data: <json>` line with
 * `candidates[0].content.parts` containing either text or complete
 * functionCall objects — Gemini does not stream partial JSON for tool
 * arguments, so we emit tool_use_start + tool_use_stop together.
 */
async function* parseGoogleStream(
  body: Response2Body,
  fallbackModel: string,
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let started = false;

  for await (const msg of parseSSE(body)) {
    if (!msg.data || msg.data === '[DONE]') continue;
    const parsed = safeParse<{
      modelVersion?: string;
      candidates?: GeminiCandidate[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    }>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const obj = parsed.value;

    if (obj.modelVersion) model = obj.modelVersion;
    if (!started) {
      started = true;
      yield { type: 'message_start', model };
    }

    const candidate = obj.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        yield { type: 'text_delta', text: part.text };
      } else if (part.functionCall) {
        const id = `${part.functionCall.name}_${Math.random().toString(36).slice(2, 10)}`;
        yield { type: 'tool_use_start', id, name: part.functionCall.name };
        yield {
          type: 'tool_use_stop',
          id,
          input: part.functionCall.args ?? {},
        };
      }
    }

    if (candidate?.finishReason) {
      stopReason = normalizeOpenAI(candidate.finishReason);
    }

    const u = obj.usageMetadata;
    if (u) {
      usage = {
        input: u.promptTokenCount ?? usage.input,
        output: u.candidatesTokenCount ?? usage.output,
        cacheRead: u.cachedContentTokenCount ?? usage.cacheRead,
      };
    }
  }

  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}