/**
 * Google Gemini provider as a declarative `WireFormatConfig`. Matches the
 * `GoogleProvider` class behavior — same canonical events, same handling
 * of `thoughtSignature` and forced `tool_use` stop reason on functionCall
 * turns.
 */
import type { Message, Request, StopReason, StreamEvent, Tool, Usage } from '@wrongstack/core';
import { randomUUID } from 'node:crypto';
import { safeParse } from '@wrongstack/core';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { normalizeGemini } from '../stop-reason.js';
import { defineWireFormat } from '../wire-format.js';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content?: unknown } };
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GoogleStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  sawFunctionCall: boolean;
  finalEmitted: boolean;
}

export const googleWireFormat = defineWireFormat<GoogleStreamState>({
  id: 'google',
  family: 'google',
  capabilities: capabilitiesForFamily('google'),
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  buildUrl: (base, req) =>
    `${base}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
  buildHeaders: (apiKey) => ({ 'x-goog-api-key': apiKey }),
  buildBody: (req: Request) => {
    const body: Record<string, unknown> = {
      contents: messagesToGemini(req.messages),
      generationConfig: buildGenConfig(req),
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
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    sawFunctionCall: false,
    finalEmitted: false,
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<{
      modelVersion?: string;
      candidates?: GeminiCandidate[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    }>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const obj = parsed.value;
    const out: StreamEvent[] = [];

    if (obj.modelVersion) state.model = obj.modelVersion;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }

    const candidate = obj.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        out.push({ type: 'text_delta', text: part.text });
      } else if (part.functionCall) {
        state.sawFunctionCall = true;
        const id = `${part.functionCall.name}_${randomUUID().slice(0, 8)}`;
        out.push({ type: 'tool_use_start', id, name: part.functionCall.name });
        const providerMeta =
          typeof part.thoughtSignature === 'string'
            ? { 'google.thoughtSignature': part.thoughtSignature }
            : undefined;
        out.push({
          type: 'tool_use_stop',
          id,
          input: part.functionCall.args ?? {},
          ...(providerMeta ? { providerMeta } : {}),
        });
      }
    }

    if (candidate?.finishReason) {
      state.stopReason = normalizeGemini(candidate.finishReason);
    }

    const u = obj.usageMetadata;
    if (u) {
      // Disjoint semantics — see google.ts for rationale.
      const cached = u.cachedContentTokenCount ?? 0;
      const promptTotal = u.promptTokenCount ?? state.usage.input + cached;
      state.usage = {
        input: Math.max(0, promptTotal - cached),
        output: u.candidatesTokenCount ?? state.usage.output,
        cacheRead: cached || state.usage.cacheRead,
      };
    }
    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    if (state.finalEmitted || !state.started) return [];
    state.finalEmitted = true;
    const finalStop: StopReason = state.sawFunctionCall ? 'tool_use' : state.stopReason;
    return [{ type: 'message_stop', stopReason: finalStop, usage: state.usage }];
  },
});

function buildGenConfig(req: Request): Record<string, unknown> {
  const cfg: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (req.temperature !== undefined) cfg['temperature'] = req.temperature;
  if (req.topP !== undefined) cfg['topP'] = req.topP;
  if (req.stopSequences) cfg['stopSequences'] = req.stopSequences;
  return cfg;
}

function toolsToGemini(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForGemini(t.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
  }));
}

const GEMINI_ALLOWED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'propertyOrdering',
  'title',
]);

function sanitizeSchemaForGemini(node: unknown): Record<string, unknown> | undefined {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) return undefined;
  if (typeof node !== 'object') return undefined;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_ALLOWED_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pname, pschema] of Object.entries(v as Record<string, unknown>)) {
        const cleaned = sanitizeSchemaForGemini(pschema);
        if (cleaned) props[pname] = cleaned;
      }
      out['properties'] = props;
    } else if (k === 'items') {
      const cleaned = sanitizeSchemaForGemini(v);
      if (cleaned) out['items'] = cleaned;
    } else if (k === 'anyOf' && Array.isArray(v)) {
      const cleaned = v
        .map((s) => sanitizeSchemaForGemini(s))
        .filter((s): s is Record<string, unknown> => s !== undefined);
      if (cleaned.length > 0) out['anyOf'] = cleaned;
    } else if (k === 'required' && Array.isArray(v)) {
      out['required'] = v.filter((s) => typeof s === 'string');
    } else if (k === 'enum' && Array.isArray(v)) {
      out['enum'] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function messagesToGemini(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks =
      typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          const part: GeminiPart = {
            functionCall: { name: b.name, args: b.input },
          };
          const sig = b.providerMeta?.['google.thoughtSignature'];
          if (typeof sig === 'string' && sig.length > 0) {
            part.thoughtSignature = sig;
          }
          parts.push(part);
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
        const responseText = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
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
