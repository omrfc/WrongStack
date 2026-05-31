# Security Audit — Filesystem Safety & Command Injection

Scope: `packages/tools/src/` filesystem + process tools, plus `cli/src/autophase-host.ts`
and `acp/src/agent/stdio-transport.ts`. Threat model: the LLM/agent is the attacker,
attempting to escape the project-root sandbox or run unintended commands against the
user's machine without user confirmation.

Audit date: 2026-05-31. Auditor: security-hunter (defensive, authorized).

---

## Findings

### 1. `diff` tool: argument injection via `a`/`b` refs → arbitrary file write outside project root (auto-permission)

- **CWE:** CWE-88 (Argument Injection) / CWE-22 (Path Traversal) → arbitrary file write
- **Severity:** High
- **Location:** `packages/tools/src/diff.ts:67-89` (`gitDiff`), tool declared `permission: 'auto'` at `diff.ts:39`

**Data flow / exploitability.** `diffTool` is registered as a builtin (`builtin.ts:51`) and is
`permission: 'auto'` — it runs with NO user confirmation. When the model supplies `a` and/or `b`,
`gitDiff` pushes them verbatim into the `git diff` argv *before* any `--` separator:

```ts
const args: string[] = ['diff', '--no-color'];
if (input.staged) args.push('--staged');
if (input.a) args.push(input.a);   // <-- model-controlled, no validation
if (input.b) args.push(input.b);   // <-- model-controlled, no validation
if (input.files) { ... args.push('--', ...files); }
```

Because these are positioned before `--`, `git` parses any leading-dash value as an option.
`git diff --output=<path>` writes the diff to an arbitrary file. A call such as
`diff({ a: "--output=../../../../tmp/pwn", b: "HEAD" })` writes outside the project root with
no confirmation prompt. Verified empirically: `git diff --output=$D/PWNED.txt HEAD` creates the
file and writes the diff into it (exit 0, file present). Other dangerous `git diff` options
(`--ext-diff` + a configured `diff.external` driver, `-O<file>`) are similarly reachable.
Content control is partial (the bytes are a real diff), but the write location is fully
attacker-chosen and the sandbox is bypassed without a confirm gate — that is the privilege
violation. There is no `findGitDir`/projectRoot containment on `a`/`b`, and the path the diff
lands in is not checked.

Contrast: every other git wrapper in the codebase (`git.ts`, `autophase-host.ts`) blocks
leading-dash injection (`startsWith('-')`) for branch/worktree inputs. `diff.ts` does not, and
it is the one that runs at `auto` permission.

**Remediation.**
- Reject `a`/`b` values that begin with `-` (flag injection guard), matching `git.ts`'s
  `validateWorktreeInput`. Prefer validating they look like commit-ish (`/^[\w./@^~-]+$/` with a
  no-leading-dash rule), or pass them after a `--` boundary where git treats them as paths.
- Alternatively raise the tool to `permission: 'confirm'` (it is the only mutating-capable git
  wrapper left at `auto`), but the flag-guard is the correct fix since the tool is meant to be
  read-only.

---

### 2. `document` tool: `files` paths bypass project-root containment (arbitrary file read)

- **CWE:** CWE-22 (Path Traversal) — arbitrary file read
- **Severity:** Low
- **Location:** `packages/tools/src/document.ts:124-137` (`resolveFiles`), tool `permission: 'confirm'` (`document.ts:40`)

**Data flow / exploitability.** `documentTool.execute` correctly `safeResolve`s `cwd` and the
single `path` input, but the `files` list is resolved by a *local* `resolveFiles` that performs
no containment check:

```ts
const absPath = f.trim().startsWith('/') ? f.trim() : `${cwd}/${f.trim()}`;
```

An absolute path (`/etc/passwd`) or `../../` traversal is read directly. The file content is read
(`fs.readFile`) and parsed; however the tool only ever *reads* — `processFile` returns items with
`status: 'skipped'` and never writes — and read content is not returned in the output (only
regex-derived symbol names/line numbers, all marked skipped). Combined with `permission: 'confirm'`
(every invocation is user-gated), the practical impact is limited: no write, no meaningful
exfiltration of arbitrary file contents. Still a real containment gap that diverges from the
codebase's `safeResolve` convention.

**Remediation.** Replace the hand-rolled join in `resolveFiles` with `safeResolve(f, ctx)` so
`files` entries are subject to the same `ensureInsideRoot` check as `path`. The function should
take `ctx`, not a bare `cwd` string.

---

### 3. Symlink escape via `safeResolve` (read/edit/write) — assessed, low residual risk

- **CWE:** CWE-59 (Link Following)
- **Severity:** Low (Info)
- **Location:** `packages/tools/src/_util.ts:8-16` (`ensureInsideRoot`); consumers `read.ts:43`, `edit.ts:55`, `write.ts:36`

**Assessment.** `ensureInsideRoot` uses `path.relative` and rejects `..`/absolute, but does NOT
call `fs.realpath`. A symlink *inside* the project root that points outside (e.g.
`<root>/link -> /etc/passwd`) passes the string check, and `read`/`edit`/`write` then follow it via
`fs.stat`/`fs.readFile`/`atomicWrite`. `read` is `permission: 'auto'`, so an auto read-through a
pre-existing in-root symlink to an out-of-root file is possible without confirmation.

Why the residual risk is low under the stated threat model: the attacker is the model writing to a
*user's own repo*. To exploit read-through, a malicious symlink must already exist in the tree
(planted by the user/repo, not by the model — the model cannot create symlinks: there is no symlink
tool, `write`/`edit` create regular files, and `atomicWrite` writes a fresh temp file then renames,
so it cannot be tricked into writing *through* a dangling link to create one). `write`/`edit` are
both `permission: 'confirm'`, so any write-through is user-gated. The realistic exposure is "auto
`read` discloses a file the user already symlinked into their repo" — minor.

Notably, `replace.ts` (the batch rewrite tool) DOES defend against this correctly:
`replace.ts:78-101` runs `fs.lstat` (skips symlinks) and `fs.realpath` cross-check against a
realpath'd root before reading/writing. `grep.ts` native walk also skips symlinks (`grep.ts:~270`),
as does `replace.ts`'s `globNative`. So the pattern is known and applied in the highest-risk
(batch-write) tool, just not in the single-file `read`/`edit`/`write`.

**Remediation (defense-in-depth).** Add an `fs.realpath` cross-check in `safeResolve`/consumers
(as `replace.ts` does): after resolving, `realpath` the target and re-run `ensureInsideRoot` on the
real path; skip/deny if it escapes. At minimum apply this to the `auto` `read` tool. Use `lstat` to
reject symlinked targets where appropriate.

---

## Checked and found SAFE (no action needed)

- **`bash.ts`** — `permission: 'confirm'`, by-design shell tool. Spawns `bash -c`/`cmd /c` with the
  raw command (intended). Gated by confirm + `subjectKey: 'command'` trust matching + circuit
  breaker + output caps + POSIX process-group kill. Not a finding.
- **`exec.ts`** — `permission: 'confirm'`. Strict command allowlist + per-command
  `BLOCKED_ARG_PATTERNS` (blocks `python -c`, `node -r/-e`, `git -c/--exec/-C`, `find -exec`,
  `npm run/exec`, `rm` on dangerous targets, `npx <pkg>`, etc.). Spawns via argv array (no shell).
  `cwd` containment-checked against project root. Strong design.
- **`git.ts`** — `permission: 'confirm'`. Argv-array spawn (no shell); built-in subcommand model;
  `validateWorktreeInput` blocks leading-dash flag injection and worktree-path escape; commit
  message via `-m` arg; file lists isolated after `--`; `findGitDir` bounded at projectRoot.
- **`_spawn-stream.ts`** — `spawn(cmd, args)` argv array, no `shell:true`. Shared by
  install/lint/format/typecheck/test/audit. Safe transport.
- **`install.ts`** — `confirm`. Package names validated against
  `^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$` + reject leading `-` + length cap (blocks flag injection and
  `file:` local specifiers). Argv-array spawn. `cwd` via `safeResolve`.
- **`scaffold.ts`** — `confirm`. Generated paths re-checked for project-root escape after template
  variable substitution; `atomicWrite`. Template `vars` only affect file *content*.
- **`patch.ts`** — `confirm`. Pre-flight rejects `+++` diff targets that escape projectRoot; forces
  `-p` strip ≥ 1; writes diff to a private `0700` mkdtemp temp dir (no symlink-bait race); argv-array
  spawn of `patch`; `directory` via `safeResolve`.
- **`replace.ts`** — `confirm`. Exemplary symlink hardening: `lstat` skip + `fs.realpath`
  cross-check against realpath'd root before read/write; writes to the realpath (so a freshly-planted
  symlink at the logical path can't redirect `atomicWrite`'s rename). `rg`/native invoked with
  argv arrays.
- **`grep.ts`** — `auto`, read-only. Pattern passed after `--` (no flag injection); `glob` passed as
  the *value* of `--glob`; `base` via `safeResolve`; user regex compiled through `compileUserRegex`
  (ReDoS cap); native walk skips symlinks. Argv-array spawn.
- **`glob.ts`** — `auto`, read-only, pure `fs.readdir` walk; `base` via `safeResolve`. No process.
- **`read.ts`** — `auto`. `safeResolve` containment, size/binary caps. Only the symlink note (#3)
  applies.
- **`write.ts` / `edit.ts`** — `confirm`. `safeResolve` containment; `atomicWrite`; read-before-write
  + mtime TOCTOU guard in `edit`. Only the symlink note (#3) applies.
- **`test.ts`** — `confirm`. `grep` passed as value of `--testNamePattern`/`--grep`; files after
  `--`; argv-array. No injection.
- **`outdated.ts`** — `auto` but argv is a fixed literal list (`outdated --json` + literal flags);
  `input.check` is declared in the schema but never appended to args; only model input reaching
  spawn is `cwd` (safeResolve'd). No injection.
- **`autophase-host.ts`** — all git calls use `spawn('git', args)` argv arrays (no shell);
  `/worktree merge` target guarded with `startsWith('-')`. `target` originates from the user-typed
  slash command, not raw model tool input.
- **`acp/src/agent/stdio-transport.ts` (`ClientTransport`)** — `spawn(command, args)` argv array, no
  shell. `command` is sourced from the fixed `ACP_AGENT_COMMANDS` registry
  (`npx`/`gemini`/`gh`/`openhands`/`goose`) or host-supplied options — not from model tool input.
- **`codebase-index/refs-extractor.ts` / `py-parser.ts` / `go-parser.ts`** — `execFileSync` with
  argv arrays (no shell); the parser script is a hardcoded constant written to an isolated temp dir;
  the indexed file path is passed as a plain argv to a parse-only AST walker (`go run`/`python` of a
  fixed script). No interpolation, no injection. (`codebase-index` tool is `auto` but the only
  process inputs are the trusted script + the file-to-parse path.)

---

## Summary

| # | Finding | CWE | Severity |
|---|---------|-----|----------|
| 1 | `diff` tool argument injection (`a`/`b` → `git diff --output=`) → arbitrary file write, auto-permission | CWE-88 / CWE-22 | High |
| 2 | `document` tool `files` bypasses `safeResolve` → arbitrary file read (read-only, confirm-gated) | CWE-22 | Low |
| 3 | `safeResolve` does not `realpath`; in-root→out-of-root symlink follow on `read`(auto)/`edit`/`write` | CWE-59 | Low/Info |

One actionable High (finding #1): the `diff` tool runs at `permission: 'auto'` and forwards
model-controlled `a`/`b` refs into `git diff` argv without a leading-dash guard, giving an
unconfirmed arbitrary-file-write primitive that escapes the project-root sandbox. Findings #2 and #3
are low-severity containment gaps that diverge from the codebase's own (otherwise solid) `safeResolve`
and symlink-hardening conventions.
