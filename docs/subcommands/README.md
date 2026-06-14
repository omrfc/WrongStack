# Subcommands - Overview

WrongStack exposes top-level subcommands via `wstack <subcommand>` (also available through the `wrongstack` binary). Unlike slash commands, which run inside a REPL/TUI session, subcommands are standalone CLI entry points.

## Full command map

| Subcommand | Handler | What it does |
|---|---|---|
| `wstack acp` | `acp.ts` | ACP integration entry point |
| `wstack init` | `init.ts` | Interactive provider/model setup, writes `~/.wrongstack/config.json` and `.wrongstack/AGENTS.md` |
| `wstack auth` | `auth.ts` | Interactive API key management |
| `wstack update` | `update.ts` | Check for WrongStack updates |
| `wstack sessions` | `sessions-config.ts` | List saved sessions; resume or delete one |
| `wstack config` | `sessions-config.ts` | Show or edit current config |
| `wstack rewind` | `rewind.ts` | Rewind active session to a previous turn |
| `wstack replay` | `replay.ts` | Replay session events |
| `wstack audit` | `audit.ts` | Inspect session/audit data |
| `wstack tools` | `tools-skills.ts` | List all registered tools |
| `wstack skills` | `tools-skills.ts` | List all available skills |
| `wstack providers` | `providers-models.ts` | List configured providers |
| `wstack models` | `providers-models.ts` | List available models for a provider |
| `wstack mcp` | `mcp.ts` | List/add/remove MCP servers or run the MCP server mode |
| `wstack plugin` | `plugin-usage.ts` | Manage plugins |
| `wstack plugins` | `plugin-usage.ts` | Alias for `wstack plugin` |
| `wstack diag` | `diag-doctor.ts` | Full diagnostic dump |
| `wstack doctor` | `diag-doctor.ts` | Run health checks |
| `wstack export` | `export.ts` | Export session data |
| `wstack usage` | `plugin-usage.ts` | Show per-plugin usage statistics |
| `wstack version` | `version-help.ts` | Show version info |
| `wstack help` | `version-help.ts` | Show help |
| `wstack projects` | `projects.ts` | List projects with WrongStack state |
| `wstack bench` | `bench.ts` | Model-independent agentic benchmarks (Aider polyglot, SWE-bench Verified) — see [bench.md](bench.md) |

## Subcommand handler interface

```typescript
type SubcommandHandler = (args: string[], deps: SubcommandDeps) => Promise<number>;

interface SubcommandDeps {
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  toolRegistry?: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  paths: WstackPaths;
  vault: SecretVault;
  cwd: string;
  projectRoot: string;
  userHome: string;
  flags?: Record<string, string | boolean>;
}
```

Exit code convention: `0` = success, `1` = generic error, `2` = config/user error, `130` = SIGINT.

## Adding a new subcommand

1. Create `packages/cli/src/subcommands/handlers/<name>.ts`.
2. Export a `const <name>Cmd: SubcommandHandler = async (args, deps) => ...`.
3. Register it in `packages/cli/src/subcommands/index.ts`.
4. Add tests under `packages/cli/tests/`.
5. Add or update docs under `docs/subcommands/`.

## vs Slash Commands

| Aspect | Subcommands | Slash commands |
|---|---|---|
| Invocation | `wstack <sub>` from shell | `/<cmd>` inside REPL/TUI |
| Context | No live agent context | Full `Context` |
| Exit | Returns exit code | Returns `{ message, exit? }` |
| Persistence | Config/session on disk | Session state and project state |
| Use case | Setup, config, project management | In-session control |
