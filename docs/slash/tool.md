# /tool - Tool Description Detail

## What it does

Configures how much prose a specific tool exposes in its top-level description and usage hint.

Default mode is `extend` for every tool. Set a noisy tool to `simple` when you want the model-facing tool catalog to use a short 1-2 line description.

## Usage

```text
/tool
/tool list
/tool <name>
/tool <name> simple
/tool <name> extend
```

Examples:

```text
/tool read simple
/tool bash extend
```

Settings are persisted under `tools.descriptionMode` and are applied to the live `ToolRegistry` immediately. Existing system-prompt text may refresh on the next prompt rebuild/session, but provider tool schemas read the live registry on each request.

## Code Reference

- `packages/cli/src/slash-commands/tool.ts`
- `packages/core/src/registry/tool-registry.ts`
- `packages/core/src/utils/tool-description-mode.ts`
