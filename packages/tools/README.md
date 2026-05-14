# @wrongstack/tools

Built-in tools the WrongStack agent uses to read, edit, and act on the user's project.

Each tool implements the `Tool` interface from [`@wrongstack/core`](../core), with a JSON schema, an `execute` function, a permission level (`auto` / `confirm` / `deny`), and security gates appropriate to its blast radius.

## Install

```bash
pnpm add @wrongstack/tools @wrongstack/core
```

## Catalog

### Filesystem

| Tool | Permission | Mutating | Notes |
|------|------------|----------|-------|
| `read` | `auto` | no | Records mtime for stale-read detection |
| `write` | `confirm` | yes | Creates new files |
| `edit` | `confirm` | yes | str_replace; requires prior `read`; FAT-aware mtime tolerance |
| `replace` | `confirm` | yes | Regex replace across files; symlink-skipped + realpath-revalidated |
| `glob` | `auto` | no | Glob pattern matching |
| `grep` | `auto` | no | rg-backed; user-regex compiled through ReDoS guard |
| `tree` | `auto` | no | Project tree; clears its polling timer (no leaks) |
| `patch` | `confirm` | yes | GNU-patch diff applier; targets pre-validated against `projectRoot` |
| `diff` | `auto` | no | Git diff against HEAD |
| `json` | `auto` | no | jq-style JSON query |

### Execution

| Tool | Permission | Mutating | Notes |
|------|------------|----------|-------|
| `bash` | `confirm` | yes | Sanitized child env; POSIX process-group kill on timeout |
| `exec` | `confirm` | yes | Allowlist-only; validated `cwd` inside `projectRoot` |
| `git` | `confirm` | yes (commits) | Typed subcommands only — no raw `args` (drops RCE via `-c …`) |

### Network

| Tool | Permission | Mutating | Notes |
|------|------------|----------|-------|
| `fetch` | `auto` | no | SSRF-hardened (IPv4 + IPv6 private CIDR, redirect re-validation, http://-downgrade refused) |
| `search` | `auto` | no | Web search via configured provider |

### Project lifecycle

| Tool | Permission | Notes |
|------|------------|-------|
| `lint` | `auto` | Project-aware lint runner (eslint / biome / ruff / golangci-lint / …) |
| `format` | `confirm` | Project-aware formatter |
| `typecheck` | `auto` | Project-aware typechecker |
| `test` | `confirm` | Project-aware test runner |
| `install` | `confirm` | Package manager install |
| `audit` | `auto` | Dependency vuln audit |
| `outdated` | `auto` | List outdated dependencies |
| `scaffold` | `confirm` | Template-based scaffolding |
| `document` | `confirm` | Inline JSDoc generation |
| `logs` | `auto` | Tail logs with rolling 100k-line window |

### Agent control

| Tool | Notes |
|------|-------|
| `todo` | TodoWrite / TodoRead for session task tracking |
| `tool_search` | Lazy-load deferred tool schemas |
| `tool_use` | Generic single-tool call |
| `batch_tool_use` | Parallel multi-tool dispatch |
| `tool_help` | Show tool usage hint |
| `remember` / `forget` | Memory-store mutations |
| `create_mode` | Author a new agent mode |

## Quick example

```ts
import { ToolRegistry } from '@wrongstack/core';
import { readTool, editTool, bashTool, builtinTools } from '@wrongstack/tools';

// Cherry-pick:
const tools = new ToolRegistry([readTool, editTool, bashTool]);

// Or take the whole built-in set:
const all = new ToolRegistry(builtinTools);
```

## Security properties (0.1.5 hardening)

- **`bash` / `exec` child env sanitized** to a fixed allowlist + secret-substring strip (`TOKEN` / `SECRET` / `PASSWORD` / `AUTH` / `BEARER` / `COOKIE` / `PRIVATE` / `KEY`). Opt-out via `WRONGSTACK_BASH_ENV_PASSTHROUGH=1`.
- **`bash` POSIX process-group kill** with `SIGTERM → 800 ms → SIGKILL`. Runaway grandchildren can't survive the timeout.
- **`fetch` SSRF defenses**: numeric CIDR checks for IPv4 (`10/8`, `127/8`, `169.254/16`, `100.64/10`, `224/4`, `240/4`, …) and 8-group-expanded IPv6 (including Node's compressed `::ffff:7f00:1` form for v4-mapped addresses). Redirect target re-validated on every hop. `http://` downgrade refused.
- **`patch` diff-target validation**: every `+++` target post-strip is resolved against `projectRoot` before GNU patch sees the diff. `strip` clamped to `≥1`. Temp diff written to a `0700 mkdtemp` directory. Run with `LANG=C` / `LC_ALL=C`.
- **`replace` / `grep` symlink-safe**: lstat + realpath + projectRoot revalidation; symlinks skipped, not followed.
- **User-regex ReDoS guard** (`_regex.ts`): 512-char cap, nested-quantifier rejection (`(a+)+`, `(?:x+)*`), 64 KB subject-line cap. Applied to `grep`, `replace`, `logs`.
- **`git` `args` raw string removed** — the `-c core.sshCommand=…` RCE bypass is no longer reachable.
- **`grep` stdout buffer capped at 1 MB** — pathological producers can't pin memory.
- **`logs` rolling window** of 100k lines max; `lines: 0` no longer means "buffer the whole file".

Full threat model: [SECURITY.md](../../SECURITY.md) at the repo root.

## Writing a custom tool

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
  // Tells permission policy which input field is the trust subject
  subjectKey: 'text',
  async execute(input, _ctx, { signal }) {
    if (signal.aborted) throw new Error('aborted');
    return input.text;
  },
};
```

See [docs/tool-author-guide.md](../../docs/tool-author-guide.md) for the full contract.

## License

MIT
