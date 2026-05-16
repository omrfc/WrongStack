# @wrongstack/runtime

Default runtime implementations and host composition types for WrongStack.

`@wrongstack/core` should stay focused on the agent kernel, public contracts,
registries, and lifecycle primitives. This package is the migration target for
concrete defaults such as storage, config, permissions, metrics, compaction,
models, skills, and host-level assembly helpers.

In the first refactor slice, runtime re-exports the existing default
implementations from `@wrongstack/core/defaults`. That lets CLI, TUI, WebUI,
and future hosts start importing defaults from `@wrongstack/runtime` while the
physical module moves happen incrementally.

```ts
import { DefaultSessionStore, DefaultPermissionPolicy } from '@wrongstack/runtime';
import { Agent, Container, EventBus } from '@wrongstack/core';
```

The `WrongStackPack` interface in `@wrongstack/runtime/pack` is the target shape
for extension packages that contribute tools, providers, slash commands, or
agent lifecycle extensions.

## Image routing

`@wrongstack/runtime/vision` owns the host-level image input decision:

- if the active provider reports `capabilities.vision`, image blocks are sent
  natively;
- otherwise, the host can provide `VisionAdapter`s that turn images into text
  descriptions before `agent.run()`;
- if neither route exists, the router throws a clear unsupported-image error
  instead of silently flattening the image to `[image]`.

`createToolVisionAdapters(toolRegistry)` can discover safe, read-only
image-understanding tools, including MCP-wrapped tools, and expose them through
the same adapter contract. Built-in MCP presets such as `zai-vision` and
`minimax-vision` are configured as read-only adapter candidates. Hosts may pass
a function that calls `createToolVisionAdapters()` at routing time so MCP
reconnects and `tools/list_changed` refreshes are picked up before each image
is analyzed.

`@wrongstack/runtime/clipboard` exposes the shared OS clipboard PNG reader used
by TUI `Alt+V` and CLI `/image`.
