import { randomUUID } from 'node:crypto';
import { type ProviderError, safeParse } from '@wrongstack/core';
import type {
  Capabilities,
  Message,
  Request,
  StopReason,
  StreamEvent,
  Tool,
  Usage,
} from '@wrongstack/core';
import { parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { parseSSE } from './sse.js';
import { normalizeGemini } from './stop-reason.js';
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
  /**
   * Gemini's signed thought blob — present on functionCall parts when
   * the model is using thinking. Must be echoed back verbatim on the
   * next request, otherwise the API rejects with:
   *   400 "Function call is missing a thought_signature in functionCall
   *   parts. This is required for tools to work correctly".
   */
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

export class GoogleProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private readonly opts: GoogleProviderOptions;

  constructor(opts: GoogleProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl);
    this.opts = opts;
    this.id = opts.id ?? 'google';
    this.capabilities = capabilitiesForFamily('google', {
      ...opts.capabilities,
    });
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
    parameters: sanitizeSchemaForGemini(t.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
  }));
}

/**
 * Gemini's function-declaration `parameters` field accepts an OpenAPI 3.0
 * Schema subset — a strict superset of "JSON Schema minus a bunch of
 * keywords". Sending the raw JSON Schema (which Zod/JSON-Schema converters
 * happily emit with `additionalProperties`, `$schema`, etc.) makes the API
 * fail with `Unknown name "additionalProperties"` and friends. Walk the
 * schema and keep only what Gemini understands.
 *
 * Spec reference (OpenAPI 3.0 Schema Object → Gemini): supported keywords
 * are type, format, description, nullable, enum, items, properties,
 * required, anyOf, minLength/maxLength, pattern, minimum/maximum,
 * minItems/maxItems, minProperties/maxProperties, propertyOrdering.
 * Anything else — additionalProperties, $schema, $ref, definitions,
 * default, examples, const, allOf, oneOf, not, dependencies, if/then/else
 * — gets dropped silently.
 */
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
  if (Array.isArray(node)) {
    // Used only for `enum` / `required` / `anyOf` arrays — handled per-key
    // below. Bare arrays here would be malformed schemas, drop.
    return undefined;
  }
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
          // Echo the thought_signature back on every assistant tool_use
          // part — Gemini's thinking models REQUIRE it on the next turn
          // or the API returns 400. The value is opaque; we just round-trip.
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
        // Prefer tool's actual name when available (e.g. executed by ToolExecutor),
        // falling back to tool_use_id or 'unknown' for manually-constructed
        // blocks in tests.
        const fnName = b.name ?? b.tool_use_id ?? 'unknown';
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
    const userParts: GeminiPart[] = [...textParts];
    // Include function responses as parts of the user turn — Gemini's API
    // accepts functionResponse blocks inline with text in a single user role.
    // This handles the case where a user message consists only of tool_result
    // blocks (no text): without this, the turn is silently dropped.
    if (functionParts.length > 0) userParts.push(...functionParts);
    if (userParts.length > 0) out.push({ role: 'user', parts: userParts });
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
  // Gemini does not have a `tool_use`/`tool_calls` finish reason — turns
  // that contain functionCall parts come back with `finishReason: "STOP"`,
  // which normalizes to `end_turn` and would otherwise make the agent
  // loop exit instead of executing the tool. Track whether we saw any
  // function call so we can force-override the stop reason at message_stop.
  let sawFunctionCall = false;

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
        sawFunctionCall = true;
        const id = randomUUID();
        yield { type: 'tool_use_start', id, name: part.functionCall.name };
        // Stash the opaque thought_signature so it can be echoed back on
        // the next request. Without this the Gemini API rejects with 400
        // "Function call is missing a thought_signature in functionCall
        // parts" on thinking models.
        const providerMeta =
          typeof part.thoughtSignature === 'string'
            ? { 'google.thoughtSignature': part.thoughtSignature }
            : undefined;
        yield {
          type: 'tool_use_stop',
          id,
          input: part.functionCall.args ?? {},
          ...(providerMeta ? { providerMeta } : {}),
        };
      }
    }

    if (candidate?.finishReason) {
      stopReason = normalizeGemini(candidate.finishReason);
    }

    const u = obj.usageMetadata;
    if (u) {
      // Disjoint semantics — see openai.ts for rationale. Gemini reports
      // `promptTokenCount` as the TOTAL (including cached) and
      // `cachedContentTokenCount` as the cached subset; subtracting keeps
      // cost / hit-ratio math correct.
      const cached = u.cachedContentTokenCount ?? 0;
      const promptTotal = u.promptTokenCount ?? usage.input + cached;
      usage = {
        input: Math.max(0, promptTotal - cached),
        output: u.candidatesTokenCount ?? usage.output,
        cacheRead: cached || usage.cacheRead,
      };
    }
  }

  if (started) {
    // Force `tool_use` when we saw any functionCall part — Gemini reports
    // `finishReason: "STOP"` for tool-call turns, which would otherwise
    // become `end_turn` and short-circuit the agent loop.
    const finalStop: StopReason = sawFunctionCall ? 'tool_use' : stopReason;
    yield { type: 'message_stop', stopReason: finalStop, usage };
  }
}
