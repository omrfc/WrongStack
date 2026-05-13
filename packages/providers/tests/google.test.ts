import { describe, it, expect, vi } from 'vitest';
import { GoogleProvider } from '../src/google.js';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response);
}

describe('GoogleProvider', () => {
  // Content-parsing tests live in streaming.test.ts since complete() wraps
  // stream() internally. This file covers headers, URLs, errors, and the
  // request-body shape.

  it('non-2xx becomes ProviderError', async () => {
    const fetchImpl = mockFetch({ error: 'bad' }, 400) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('requires apiKey', () => {
    expect(() => new GoogleProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('marks 429 and 5xx as retryable', async () => {
    const fetchImpl = mockFetch({}, 503) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('translates system, tool, tool_result through wire format', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'k' }] }, finishReason: 'stop' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini-2.5-flash',
        maxTokens: 50,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ['<end>'],
        system: [{ type: 'text', text: 'be terse' }],
        messages: [
          { role: 'user', content: 'see this' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'reading' },
              { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'data' },
            ],
          },
        ],
        tools: [
          {
            name: 'read',
            description: 'read',
            inputSchema: { type: 'object' },
            permission: 'auto',
            mutating: false,
            async execute() {
              return '';
            },
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(body?.['systemInstruction']).toEqual({ parts: [{ text: 'be terse' }] });
    const contents = body?.['contents'] as Array<{ role: string; parts: unknown[] }>;
    expect(contents.find((c) => c.role === 'model')).toBeDefined();
    expect(contents.find((c) => c.role === 'function')).toBeDefined();
    const tools = body?.['tools'] as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0]?.functionDeclarations).toHaveLength(1);
    const cfg = body?.['generationConfig'] as Record<string, unknown>;
    expect(cfg['temperature']).toBe(0.5);
    expect(cfg['stopSequences']).toEqual(['<end>']);
  });

  it('translates base64 image to inlineData part', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const contents = body?.['contents'] as Array<{ parts: Array<Record<string, unknown>> }>;
    const userParts = contents[0]!.parts;
    const inline = userParts.find((p) => p['inlineData']);
    expect(inline?.['inlineData']).toEqual({ mimeType: 'image/jpeg', data: 'AAA' });
  });

  it('echoes thought_signature back on subsequent assistant tool_use parts', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'k' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [
          { role: 'user', content: 'do it' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu1',
                name: 'read',
                input: { path: 'a' },
                providerMeta: { 'google.thoughtSignature': 'SIG-BLOB-123' },
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'ok' }],
          },
        ],
        tools: [
          {
            name: 'read',
            description: 'read',
            inputSchema: { type: 'object' },
            permission: 'auto',
            mutating: false,
            async execute() {
              return '';
            },
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const contents = body?.['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const modelTurn = contents.find((c) => c.role === 'model');
    const fc = modelTurn?.parts.find((p) => p['functionCall']);
    expect(fc?.['thoughtSignature']).toBe('SIG-BLOB-123');
  });

  it('strips JSON-Schema keywords Gemini rejects (additionalProperties, $schema, default, allOf)', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      body = JSON.parse(init.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: {},
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const p = new GoogleProvider({ apiKey: 'k', fetchImpl });
    await p.complete(
      {
        model: 'gemini',
        maxTokens: 1,
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'edit',
            description: 'edit',
            permission: 'auto',
            mutating: true,
            async execute() {
              return '';
            },
            inputSchema: {
              type: 'object',
              $schema: 'http://json-schema.org/draft-07/schema#',
              additionalProperties: false,
              required: ['path'],
              properties: {
                path: { type: 'string', description: 'where' },
                opts: {
                  type: 'object',
                  additionalProperties: false,
                  default: {},
                  properties: {
                    nested: { type: 'string', allOf: [{ minLength: 1 }] },
                  },
                },
                tags: {
                  type: 'array',
                  items: { type: 'string', $ref: '#/defs/Tag' },
                },
              },
            } as Record<string, unknown>,
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const tools = body?.['tools'] as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    const params = tools[0]!.functionDeclarations[0]!.parameters;
    // Top-level forbidden keys are gone
    expect(params['additionalProperties']).toBeUndefined();
    expect(params['$schema']).toBeUndefined();
    // Allowed keys survive
    expect(params['type']).toBe('object');
    expect(params['required']).toEqual(['path']);
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['path']).toEqual({ type: 'string', description: 'where' });
    // Nested object also sanitized
    expect(props['opts']?.['additionalProperties']).toBeUndefined();
    expect(props['opts']?.['default']).toBeUndefined();
    const nested = (props['opts']?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.['nested'];
    expect(nested?.['allOf']).toBeUndefined();
    expect(nested?.['type']).toBe('string');
    // Array items sanitized
    expect((props['tags']?.['items'] as Record<string, unknown>)?.['$ref']).toBeUndefined();
    expect((props['tags']?.['items'] as Record<string, unknown>)?.['type']).toBe('string');
  });
});
