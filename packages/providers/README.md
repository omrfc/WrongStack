# @wrongstack/providers

LLM provider adapters for WrongStack: Anthropic, OpenAI, Google, OpenAI-compatible (Mistral, Groq, DeepSeek, Together, Fireworks, OpenRouter, …).

Most providers ride a single declarative `WireFormatConfig` adapter; only the three majors (Anthropic / OpenAI / Google) have hand-written classes. Adding a new provider is usually a 20-line preset, not a new file.

## Install

```bash
pnpm add @wrongstack/providers @wrongstack/core
```

`@wrongstack/core` is a peer of every provider — providers depend on the core `Provider` interface, message types, and tool format.

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
  modelId: 'claude-sonnet-4-6',
});

const stream = provider.stream({
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
});

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
  baseURL: 'https://api.groq.com/openai/v1',
  modelId: 'llama-3.3-70b-versatile',
  capabilities: { tools: true, vision: false, maxContext: 128_000 },
});
```

## Wire-format adapter (declarative)

For a new provider that doesn't fit one of the existing presets, write a `WireFormatConfig` and plug it into `WireAdapter`. See [docs/provider-author-guide.md](../../docs/provider-author-guide.md) for the full spec.

```ts
import { WireAdapter } from '@wrongstack/providers';
import type { WireFormatConfig } from '@wrongstack/core';

const myWire: WireFormatConfig = {
  family: 'openai',
  endpoint: 'https://api.myprovider.com/v1/chat/completions',
  authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  // tool format, message shape, stream parsing — see WireFormatConfig type
};

const provider = new WireAdapter({
  id: 'myprovider',
  apiKey: '…',
  modelId: 'my-model-1',
  wire: myWire,
  capabilities: { tools: true, maxContext: 32_000 },
});
```

## Tool input parsing (`parseToolInput`)

All four stream parsers (anthropic / openai / aggregate + the three OpenAI-compatible presets) run tool-call JSON through one canonical helper: [`_tool-input.ts`](src/_tool-input.ts). It guarantees the agent always receives a `Record<string, unknown>` for `tool_use.input`, never a parse-error or `null`. Invalid or non-object inputs are wrapped under `{ __raw: ... }` instead of crashing the provider runner.

## Capabilities

The capability flags on each provider come from [models.dev](https://models.dev) catalog data, mapped by `capabilitiesFor()`. The agent uses them to pick adaptive context-management thresholds, gate vision/reasoning features, and refuse tools on models that don't support tool calls.

## License

MIT
