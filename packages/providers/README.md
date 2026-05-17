# @wrongstack/providers

LLM provider adapters for WrongStack: Anthropic, OpenAI, Google, OpenAI-compatible (Mistral, Groq, DeepSeek, Together, Fireworks, OpenRouter, …).

Most providers ride a single declarative `WireFormatConfig` adapter; only the three majors (Anthropic / OpenAI / Google) have hand-written classes. Adding a new provider is usually a 20-line preset, not a new file.

## Install

```bash
pnpm add @wrongstack/providers @wrongstack/core
```

`@wrongstack/core` provides the shared `Provider` interface, message types, and tool format.

## What's in here

```
src/
  anthropic.ts             native Anthropic Messages API
  openai.ts                native OpenAI Chat Completions API
  google.ts                native Google Gemini generateContent API
  openai-compatible.ts     drop-in for any /v1/chat/completions endpoint
  wire-adapter.ts          declarative adapter — pass a WireFormatConfig
  presets/                 wire configs for anthropic / openai / google / mistral
  sse.ts                   SSE parser with 256 KB buffer cap
  aggregate.ts             tool_use stream-event aggregator
  tool-format/             tools ↔ Anthropic / OpenAI converters
  stop-reason.ts           normalize provider stop_reason → canonical
  error-parse.ts           parse provider HTTP error envelopes
  capabilities.ts          map models.dev capability strings → bool flags
```

## Quick example

```ts
import { AnthropicProvider } from '@wrongstack/providers';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const stream = provider.stream(
  {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 512,
  },
  { signal: new AbortController().signal },
);

for await (const event of stream) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

## Using a preset (OpenAI-compatible service)

```ts
import { OpenAICompatibleProvider } from '@wrongstack/providers';

const groq = new OpenAICompatibleProvider({
  id: 'groq',
  apiKey: process.env.GROQ_API_KEY!,
  baseUrl: 'https://api.groq.com/openai/v1',
  capabilities: { tools: true, vision: false, maxContext: 128_000 },
});

const result = await groq.complete(
  {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 512,
  },
  { signal: new AbortController().signal },
);
```

## Wire-format adapter (declarative)

For a new provider that doesn't fit one of the existing presets, write a `WireFormatConfig` and plug it into `WireFormatProvider`. See [docs/provider-author-guide.md](../../docs/provider-author-guide.md) for the full spec.

```ts
import { WireFormatProvider, type WireFormatConfig } from '@wrongstack/providers';

const myWire: WireFormatConfig = {
  id: 'myprovider',
  family: 'openai-compatible',
  capabilities: { tools: true, parallelTools: true, vision: false, streaming: true, promptCache: false, systemPrompt: true, jsonMode: false, maxContext: 32_000, cacheControl: 'none' },
  defaultBaseUrl: 'https://api.myprovider.com/v1',
  buildUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req) => ({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, stream: true }),
  createStreamState: (fallbackModel) => ({ model: fallbackModel, started: false }),
  parseStreamEvent: () => [],
  finalizeStream: () => [{ type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } }],
};

const provider = new WireFormatProvider(myWire, {
  apiKey: '…',
});
```

## Tool input parsing (`parseToolInput`)

Anthropic/OpenAI-style stream parsers and the aggregate path run tool-call JSON through one canonical helper: [`_tool-input.ts`](src/_tool-input.ts). It guarantees the agent always receives a `Record<string, unknown>` for `tool_use.input`, never a parse-error or `null`. Invalid or non-object inputs are wrapped under `{ __raw: ... }` instead of crashing the provider runner.

## Capabilities

The capability flags on each provider come from [models.dev](https://models.dev) catalog data, mapped by `capabilitiesFor()`. The agent uses them to pick adaptive context-management thresholds, gate vision/reasoning features, and refuse tools on models that don't support tool calls.

## License

MIT
