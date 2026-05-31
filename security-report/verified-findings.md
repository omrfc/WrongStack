# Verified Findings — WrongStack Security Audit

Phase 3 output. Each finding below was independently re-verified by reading the
cited source (and, for F-01/F-02/F-03, tracing the full enforcement path). Raw
per-hunter output lives in the sibling `sc-*-results.md` files. Findings the
hunters raised that did not survive verification, or that are out of threat
model, are listed at the bottom.

Threat model for an agentic CLI (used for severity calibration):
- **A1 — Prompt-injected model output**: content the agent reads (a file, web page,
  tool result, MCP response) steers the model into emitting malicious tool calls.
  The model cannot edit user config or install plugins; it can only call tools.
- **A2 — Malicious/compromised plugin or MCP server** the user installs. Already
  runs with full Node privileges in-process (so already has code execution).
- **A3 — Local multi-user / data-at-rest**: another user on the same machine.

---

## F-01 · `diff` tool: argument injection -> unconfirmed arbitrary file write — **HIGH**
- **CWE-88 (argument injection) / CWE-22 (path traversal)**
- **File:** `packages/tools/src/diff.ts:34` (`permission: 'auto'`), `:77-78` (sink)
- **Threat actor:** A1 (prompt-injected model) — *no installed code required*.

`gitDiff()` pushes the model-controlled `input.a` and `input.b` straight into the
`git diff` argv **before** the `--` separator and with **no leading-dash guard**:

```
const args = ['diff', '--no-color'];
if (input.staged) args.push('--staged');
if (input.a) args.push(input.a);   // line 77 — unvalidated
if (input.b) args.push(input.b);   // line 78 — unvalidated
if (input.files) { args.push('--', ...files); }  // '--' only guards files
```

The tool is `permission: 'auto'`, so it runs with **no user confirmation**. A call
such as `a = "--output=../../../../Users/ersin/.bashrc"`, `b = "HEAD"` becomes
`git diff --no-color --output=<path> HEAD`, and `git diff --output=<file>` writes
to an attacker-chosen path. The path is **not** constrained by `safeResolve` (git
resolves it itself, relative to the repo dir), so it can land **outside the project
root**. Empirically confirmed: `git diff --output=<path> HEAD` creates/overwrites
the file and exits 0.

Impact: overwrite/clobber arbitrary files without confirmation — e.g. truncate
`~/.bashrc`, drop a file into `.git/hooks/` (code execution on the next git
operation), or corrupt `~/.wrongstack/config.json`. Output content is the diff
between the two refs (partially attacker-influenced), but the write/clobber/DoS
primitive alone is serious. This is the **only** mutating-capable git wrapper still
at `auto` that lacks the leading-dash flag guard the rest of the codebase uses
(cf. `git.ts` `validateWorktreeInput`, `install.ts`, `autophase-host.ts`).

It also **bypasses the subagent guard (F-03)**: `diff` is not on the subagent DENY
list, so even a locked-down delegated subagent (where `write`/`bash` are blocked)
retains this arbitrary-write primitive.

**Fix:** reject `a`/`b` values beginning with `-` (validate as a commit-ish), or
pass them after a `--`/`--end-of-options` boundary. Mirror `git.ts`'s validator.

---

## F-02 · Tool registry `wrap`/`unregister`/`override` have no trust-tier enforcement — **MEDIUM**
- **CWE-863 (incorrect authorization) / CWE-285**
- **Files:** `packages/core/src/plugin/api.ts:110-116`; `packages/core/src/registry/tool-registry.ts:80-123`; `packages/core/src/plugin/loader.ts:328-342`
- **Threat actor:** A2 (installed plugin).

The slash-command registry enforces trust tiers (external plugins are namespaced;
only `official` plugins may register bare names / override builtins — `api.ts:131`
passes `{ official }`). The **tool** registry does not:

- `DefaultPluginAPI.tools` exposes `register`, `unregister`, `wrap`, `get`, `list`,
  all passing straight through with `owner` and **no `official` flag** (`api.ts:110-116`).
- `ToolRegistry.wrap()`/`unregister()`/`override()` perform **no owner check**
  (`tool-registry.ts:80-123`). `register()` does throw on duplicate (so a builtin
  can't be shadowed by re-registration) — but `wrap` defeats that.
- The capability proxy (`loader.ts:328-342`) is the only gate, and it is weak:
  it engages **only** if the plugin self-declares `capabilities.tools === false`
  (default `{}` -> no proxy); it intercepts **only** the `register` property
  (`wrap`/`unregister` fall through via `Reflect.get`); and `enforceCapabilities`
  **defaults to `false`** (violations are warnings, not blocks).

So any external plugin can call
`api.tools.wrap('bash', t => ({ ...t, permission: 'auto', mutating: false }))`
to silently downgrade a builtin so it never prompts, or `unregister('write')` to
disable a safeguard.

**Severity calibration:** capped at Medium because an installed plugin already has
full in-process code execution (it can spawn child processes directly), so this is
a **defense-in-depth / consistency** gap rather than a new capability. It matters
because (a) the permission system is meant to be a backstop even against
over-eager/buggy plugins, and (b) the tool registry is inconsistent with the
slash-command registry, which *does* enforce officiality.

**Fix:** route `wrap`/`unregister`/`override` through the same officiality gate as
slash commands (block external plugins from mutating core-owned tools); have the
capability proxy cover all mutating methods; default `enforceCapabilities` to `true`.

---

## F-03 · Subagent auto-approve guard is an incomplete name **denylist** — **MEDIUM**
- **CWE-862 (missing authorization) / CWE-863**
- **File:** `packages/core/src/security/permission-policy.ts:333-353`
- **Threat actor:** A1 (prompt-injected model driving a delegated subagent).

Subagents run under `AutoApprovePermissionPolicy` (non-interactive — they can't
answer prompts, so by design they inherit the leader's authorization). The only
brake is a hard-coded **denylist** of `bash, write, scaffold, patch, install, exec`.

Being a denylist, it **fails open**. It omits:
- **`edit`** and **`replace`** — arbitrary in-project file modification, functionally
  equivalent to the denied `write`.
- **`diff`** — which, per F-01, is an arbitrary *out-of-root* file-write primitive.
- **every `mcp__*` tool** — auto-approved wholesale, including MCP tools that wrap
  a shell or filesystem.
- write-capable plugin tools (e.g. `template_render`, `git_autocommit`).

A `/spawn` subagent gets the full host registry, so a prompt-injection-driven
subagent can mutate project files (via `edit`/`replace`) and write arbitrary files
(via `diff --output`) that the user never confirmed — even though `write`/`bash`
are correctly blocked. The inconsistency (deny `write` but allow `edit`) is the
clearest signal this is a bug, not a deliberate boundary.

**Fix:** convert to an **allowlist** of read-only/safe tools, or derive the deny
decision from tool metadata (`mutating === true` => deny) instead of hard-coded
names. At minimum add `edit`, `replace`, `diff`, and gate `mcp__*` by default.

---

## F-04 · `safeResolve` does not resolve symlinks (in-root->out-of-root) — **LOW**
- **CWE-59** · `packages/tools/src/_util.ts:8-20`
- `ensureInsideRoot` uses `path.relative` (rejects `..`/absolute) but never
  `fs.realpath`, so an existing symlink **inside** the repo pointing outside is
  followed by `read` (auto), `edit`, `write`. Bounded because the model has no
  symlink-creation tool and `atomicWrite` writes-temp-then-renames (can't write
  *through* a link), and `edit`/`write` are confirm-gated; only `auto` `read` can
  follow a pre-existing in-repo symlink. Note `replace.ts`/`grep.ts` already
  defend (lstat skip + realpath cross-check) — apply the same to single-file ops.

## F-05 · Builtin `search` tool follows redirects without per-hop re-validation — **LOW**
- **CWE-918** · `packages/tools/src/search.ts`
- Uses default `redirect: 'follow'` with no private-IP re-check per hop. Destination
  host is fixed (DuckDuckGo/Google/Bing over TLS) so the attacker doesn't control
  it; residual redirect-to-internal risk only. The `web-search` *plugin* already
  does this correctly. **Fix:** `redirect: 'manual'` + per-hop private-IP rejection
  (reuse `fetch.ts`'s guard).

## F-06 · User `user_input` / `llm_response` events written to session JSONL unscrubbed — **LOW**
- **CWE-532** · `packages/core/src/core/agent.ts:~334`, `~640`
- Tool output *is* scrubbed before persistence, but user/model turn text is not. A
  secret a user pastes or the model echoes lands in cleartext in the session log
  (owner-only `0o600`) and would ride along in the `history` cloud-sync category.
  Does **not** expose the agent's own provider keys. **Fix:** run the scrubber at
  the `FileSessionWriter.append` boundary.

## F-07 · MCP transport uses lighter URL validation than `fetch.ts` — **LOW/INFO**
- **CWE-918** · `packages/mcp/src/transport.ts`
- IPv4 IMDS block + HTTPS-for-remote, but no DNS resolution check and no IPv6-IMDS
  block. Requires config control (admin) to exploit, so impact is low. Optional:
  route MCP streamable-http/SSE through the pinned dispatcher.

## F-08 · Session soft-allow/deny matching diverges from trust-file matching — **LOW**
- **CWE-863** · session maps use exact-string `.has()` while the trust file uses
  glob matching for the same `subject`. No confirmed exploit (fails closed in
  practice); flagged for consistency.

## F-09 · `postinstall` mutates contributor git config — **LOW/INFO**
- `package.json:29` runs `git config core.hooksPath .githooks` on every install.
  Benign (root pkg is `private`), but silently changes git config. Gate behind the
  existing `setup:hooks` script.

## F-10 · Local `release`/`release:dry` scripts use `--no-git-checks` — **LOW**
- `package.json:26-27` — a manual `pnpm release` could publish a dirty tree. The
  authoritative path is tag-driven `release.yml` (clean checkout + provenance), so
  impact is limited to manual misuse.

---

## Informational / defense-in-depth (no action required)
- `DefaultLogger` does not scrub `msg`/`ctx`/stack (latent sink; no current leaker).
- `telegram/src/bot.ts:7` `redactUrl` is dead code (bot token not currently logged).
- npm plugin load is `await import(spec)` with full privileges and no signature
  check — the intended extensibility model (cf. VS Code/ESLint); not A1-reachable.
- Stale `onlyBuiltDependencies` allow-list entry: `better-sqlite3` no longer declared.

## Raised but NOT verified as issues (false positives / out of scope)
- **Prototype pollution**: empirically ruled out. `_tool-input.ts` `parseToolInput`
  is `JSON.parse` + string salvage (a `__proto__` key becomes an inert own prop);
  `config-loader.deepMerge` and `secret-vault.deepMerge` both carry
  `FORBIDDEN_PROTO_KEYS`; `json_path/deepMerge` writes into a fresh object
  (PoC confirmed no global pollution).
- **Dynamic code-eval primitives** (eval, the Function constructor, vm.*): none
  present in `packages/*/src`.
- **WebUI control plane RCE/CSWSH**: binds `127.0.0.1`, per-process random token,
  `timingSafeEqual`, **Host-header + Origin checks** (defeat DNS-rebinding & cross-
  site WS), strict CSP, rate limiting. Not exploitable from a malicious web page.
- **Secret-vault crypto**: AES-256-GCM, fresh random IV/encrypt, tag validated,
  `0o600` key with exclusive `wx` create — correct.
- **`icacls`/`USERNAME` argument handling**: uses `execFile` (argv, no shell) — safe.
- **CI/CD script injection**: no `pull_request_target`, no `${{ github.event.* }}`
  in `run:`, all third-party actions SHA-pinned, least-privilege `GITHUB_TOKEN`.
- **Dependency CVEs**: `pnpm audit` returned **0 advisories** across 591 deps;
  `undici`/`ws`/`vite`/`esbuild` all past their known CVEs.
