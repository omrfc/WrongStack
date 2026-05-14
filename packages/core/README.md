# @wrongstack/core

Kernel, types, and default implementations that drive the WrongStack CLI agent.

This package has no `bin`. It's a library you'd depend on if you were building a plugin, embedding the agent in another tool, or replacing one of the default implementations (a custom session store, a stricter permission policy, your own retry strategy).

If you're just using WrongStack from the terminal, install [`wrongstack`](../../README.md) instead.

## Install

```bash
pnpm add @wrongstack/core
```

Requires **Node.js ≥ 22.0.0**.

## What's in here

```
src/
  core/         — Agent, Context, ConversationState, ProviderRunner, InputBuilder
  defaults/     — Production-ready implementations (session store, secret vault, …)
  kernel/       — Container, TOKENS, EventBus, ToolRegistry, ProviderRegistry
  plugin/       — Plugin loader, PluginAPI, manifest validation
  registry/     — SlashCommandRegistry, ToolRegistry, ProviderRegistry
  types/        — Public type surface (Tool, Provider, SessionStore, …)
  utils/        — wstack-paths, safe-json, deterministic-stringify, lru-cache
```

## Quick example

Run an agent loop with the Anthropic provider and a single tool:

```ts
import {
  Agent,
  Container,
  Context,
  DefaultEventBus,
  DefaultLogger,
  DefaultPermissionPolicy,
  DefaultSessionStore,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  ToolRegistry,
  TOKENS,
} from '@wrongstack/core';
import { AnthropicProvider } from '@wrongstack/providers';
import { readTool, writeTool, bashTool } from '@wrongstack/tools';

const container = new Container();
container.bind(TOKENS.EventBus, () => new DefaultEventBus());
container.bind(TOKENS.Logger, () => new DefaultLogger());
container.bind(TOKENS.PermissionPolicy, () => new DefaultPermissionPolicy());

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
const tools = new ToolRegistry([readTool, writeTool, bashTool]);

const ctx = new Context({
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  provider,
  model: 'claude-sonnet-4-6',
  tokenCounter: new DefaultTokenCounter({ providerId: 'anthropic' }),
});

const agent = new Agent({
  container,
  ctx,
  tools,
  systemPromptBuilder: new DefaultSystemPromptBuilder(),
});

const result = await agent.run({
  input: { text: 'list the files in src/' },
});

console.log(result.assistantText);
```

## Replacing a default

Every concrete class under `defaults/` implements an interface in `types/`. The container resolves by token, so swapping is a one-line change:

```ts
import { TOKENS } from '@wrongstack/core';

class StrictPolicy implements PermissionPolicy {
  async check(tool, input, ctx) {
    if (tool.name === 'bash') return { decision: 'deny', reason: 'no shell' };
    return { decision: 'allow' };
  }
}

container.bind(TOKENS.PermissionPolicy, () => new StrictPolicy());
```

The same pattern works for `SessionStore`, `MemoryStore`, `SystemPromptBuilder`, `RetryPolicy`, `ErrorHandler`, `TokenCounter`, `SecretVault`, `SecretScrubber`, `Compactor`, `ConfigStore`, `ModelsRegistry`, `ModeStore`.

## Building a tool

```ts
import type { Tool } from '@wrongstack/core';

export const echoTool: Tool<{ text: string }, string> = {
  name: 'echo',
  description: 'Echo a string back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  permission: 'auto',
  mutating: false,
  async execute(input) {
    return input.text;
  },
};
```

See [docs/tool-author-guide.md](../../docs/tool-author-guide.md) for the full contract (`subjectKey`, `executeStream`, `cleanup`, abort handling, output bounds).

## Building a provider

Most providers can ride the declarative wire-format adapter — see [`@wrongstack/providers`](../providers). For direct implementation, see [docs/provider-author-guide.md](../../docs/provider-author-guide.md).

## Building a plugin

```ts
import type { Plugin } from '@wrongstack/core';

export default {
  name: 'my-plugin',
  version: '1.0.0',
  capabilities: { tools: true, slashCommands: true },
  async setup(api) {
    api.registerTool(myTool);
    api.registerSlashCommand({ name: 'my-cmd', description: '…', run: async () => {} });
  },
} satisfies Plugin;
```

See [docs/plugin-author-guide.md](../../docs/plugin-author-guide.md).

## Path layout

All developer-level state lives under `~/.wrongstack/`. Per-project state is keyed by `sha256(absoluteProjectRoot).slice(0,12)` under `~/.wrongstack/projects/<hash>/`. The only thing inside the project tree itself is the optional, committable `.wrongstack/AGENTS.md` and `.wrongstack/skills/`. See `WstackPaths` in [utils/wstack-paths.ts](src/utils/wstack-paths.ts) for the full layout.

## Security model

See [SECURITY.md](../../SECURITY.md) at the repo root for the threat model, adversary trust assumptions, and the catalog of controls (SSRF defenses, child-env sanitization, secret vault, prompt-injection assumptions for LLM-generated tool inputs).

## License

MIT
