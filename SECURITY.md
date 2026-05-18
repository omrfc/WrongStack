# WrongStack — Threat Model & Security Posture

This document captures the threat model the codebase is hardened against,
which controls live where, and which decisions were made deliberately so
future contributors don't undo them. It is intentionally short on
prescriptions and long on context.

## Reporting a vulnerability

Please email security reports to ersinkoc@gmail.com. Do not file public
GitHub issues for unpatched vulnerabilities.

## Adversary model

The agent reads instructions from three layers, and each layer has a
different trust posture:

| Source                          | Trust  | Why                                                |
|---------------------------------|--------|----------------------------------------------------|
| User typing in the REPL         | high   | Local human operating their own machine.           |
| Local config files / env vars   | high   | User-owned; same trust as the process itself.      |
| LLM-generated tool inputs       | **none** | Treat as adversarial. Prompt injection is real. |
| Web pages fetched by `fetch`    | **none** | Anything reachable over HTTP can carry hostile content. |
| MCP server responses            | low    | Third-party; could be compromised or malicious.    |
| File contents read by tools     | low    | A repo may carry hostile content (`.env`, plants). |

The single most important rule: **anything the LLM emits as a tool input is
adversarial**. A prompt-injection attack can flip an otherwise-honest model
into emitting `git args="-c core.sshCommand=…"` or
`fetch url="http://169.254.169.254/…"` — without the user noticing. The
mitigations in this codebase exist to make those payloads ineffective even
when permission prompts are approved out of habit.

## Controls in place (as of 0.1.10)

### Sandbox boundary on shell-style tools

- **`bash` tool** ([packages/tools/src/bash.ts](packages/tools/src/bash.ts))
  - Runs via the user's shell — gives the model full local execution.
  - **Child env is sanitized** ([packages/tools/src/_env.ts](packages/tools/src/_env.ts)): allowlist (PATH, HOME, LANG, …) plus a secret-name strip
    (TOKEN/SECRET/PASSWORD/AUTH/BEARER/COOKIE/PRIVATE substrings, KEY with
    word boundary). Provider API keys, GitHub PATs, AWS creds never reach
    the child. Override with `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` if you
    explicitly need passthrough.
  - **POSIX process-group kill** on timeout/abort so
    `bash -c "sleep 9999 & disown"` doesn't orphan a grandchild.

- **`exec` tool** ([packages/tools/src/exec.ts](packages/tools/src/exec.ts))
  - Strict allowlist (`node`/`npm`/`pnpm`/`git`/`tsc`/…); no escape hatch.
    The previous `allow_unknown` flag was dropped — for arbitrary commands
    use `bash` (which is more clearly gated).
  - `cwd` parameter validated to resolve inside `ctx.projectRoot`.
  - Same env sanitization as `bash`.

- **`git` tool** ([packages/tools/src/git.ts](packages/tools/src/git.ts))
  - No raw `args` field. Removed because it allowed
    `-c core.sshCommand=…` and `--upload-pack='sh -c …'` RCE.
  - `findGitDir` is bounded by `ctx.projectRoot` so a non-git project
    doesn't walk up into an unrelated parent repo.

- **`patch` tool** ([packages/tools/src/patch.ts](packages/tools/src/patch.ts))
  - Diff `+++` targets pre-validated against `projectRoot` before invoking
    GNU patch. `strip` forced ≥1 (rejects `strip:0` absolute-path escapes).
  - Temp diff file written into a `0700 mkdtemp` private directory rather
    than a predictable timestamp name in the user's tree.
  - `LC_ALL=C` set so applied-count detection (`grep "patching file"`)
    isn't fooled by a localized GNU patch.

- **`replace` tool** ([packages/tools/src/replace.ts](packages/tools/src/replace.ts))
  - Uses `lstat` to detect symlinks and `realpath` to validate the resolved
    target is still inside `projectRoot`. Writes through `realPath`, never
    through the original (which could be a planted symlink).

- **`grep` tool** ([packages/tools/src/grep.ts](packages/tools/src/grep.ts))
  - Native walker skips symbolic links.
  - User-supplied regex compiled through
    [packages/tools/src/_regex.ts](packages/tools/src/_regex.ts) — 512-char
    cap and rejection of obvious super-linear constructs like `(a+)+`.
  - Subject line capped at 64 KB before sync regex eval.
  - `rg` stdout buffer capped at 1 MB.

### Network egress: `fetch` tool

[packages/tools/src/fetch.ts](packages/tools/src/fetch.ts)

- **HTTPS only by default.** `http://` requires `WRONGSTACK_FETCH_ALLOW_PRIVATE=1`.
- **Private/loopback/multicast/CGNAT/metadata blocking** via numeric
  comparison (not substring regex):
  - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16,
    192.0.0/24, 224/4 (multicast), 240/4 (reserved).
  - IPv6: full expansion to 8 groups; blocks ::, ::1, fc00::/7, fe80::/10,
    ff00::/8, and **all IPv4-mapped forms** (including Node's normalized
    `::ffff:7f00:1` form for `::ffff:127.0.0.1`).
- **Redirect target re-validated every hop.** A public host's 302 to AWS
  IMDS will be refused at hop 2.
- **DNS pre-resolution.** Hostnames are resolved via `dns.lookup` and each
  record checked. Known limitation: this is **best-effort against DNS
  rebinding** — Node's `fetch` does its own lookup and could in principle
  see a rebound IP. For a hard guarantee we'd need an undici Agent with a
  pinned `lookup` callback. Acceptable risk today given that the redirect
  re-check catches the trivial bypasses; reconsider if WrongStack is used
  in a hostile multi-tenant context.
- **Body cap 128 KB**, **timeout 20s**, **5 redirect max**.

### Secrets at rest

- **AES-256-GCM vault** ([packages/core/src/security/secret-vault.ts](packages/core/src/security/secret-vault.ts))
  for `apiKey`-shaped fields in `~/.wrongstack/config.json`. Key file
  written with `0o600` and `'wx'` exclusive-create flag (race-safe).
- **Per-field decrypt** — one corrupted ciphertext doesn't kill boot;
  affected field is zeroed and logged.
- **Plaintext migration** on every boot for users coming from earlier
  versions: detects unencrypted secret-bearing keys and rewrites the
  config encrypted.
- **Secret scrubber** ([packages/core/src/security/secret-scrubber.ts](packages/core/src/security/secret-scrubber.ts))
  redacts known key shapes (Anthropic / OpenAI / GitHub / GCP / Slack /
  Stripe / AWS / Twilio / JWT / mongo-postgres-mysql-redis URIs / Bearer
  / generic high-entropy `*_KEY=` patterns) from any text or object before
  display or storage. 64 KB input chunking guards lookbehind patterns.

### Permission policy

[packages/core/src/security/permission-policy.ts](packages/core/src/security/permission-policy.ts)

- Trust rules: per-tool allow/deny glob patterns persisted to
  `~/.wrongstack/trust.json` via atomic write.
- **Glob metacharacters in tool input are escaped** before pattern match
  — a crafted bash command `git **` cannot itself act as a glob.
- **Per-tool `subjectKey`** (e.g. bash → `command`, fetch → `url`)
  declares which input field is the trust subject. Without this the
  policy heuristic could mismatch across tools — an HTTP tool whose
  `path` means request-path would have been checked against filesystem
  trust rules.

### Provider boundary

- **Tool-call argument validation** ([packages/providers/src/_tool-input.ts](packages/providers/src/_tool-input.ts)):
  every stream parser routes tool args through `parseToolInput` so the
  result is always a `Record<string, unknown>`. Provider responses with
  `args: null`, an array, or invalid JSON are wrapped under `__raw`
  instead of crashing the tool executor.
- **SSE parser** ([packages/providers/src/sse.ts](packages/providers/src/sse.ts))
  caps the pending-line buffer at 256 KB and normalizes CRLF
  incrementally to avoid O(n²) blowup.

### MCP boundary

- **Pending RPC drain** on child exit / `close()` so callers don't hang
  on a dead transport.
- **SIGTERM → SIGKILL escalation** on stuck children.
- **Slot-scoped disconnect listeners** — fixes a Set-keyed-by-arrow-fn
  bug that accumulated listeners across reconnect cycles.
- **HTTP error bodies capped** at 1 KB in error messages.

## Known limitations / deliberate non-goals

- **Multi-tenant hostile environments are not the target.** The agent
  runs with the invoking user's privileges and has full filesystem and
  network access. The threat model is "untrusted LLM output", not
  "untrusted operator".
- **No syscall sandboxing.** A sufficiently determined model+user
  combination can still run anything — we only raise the bar against
  prompt injection.
- **DNS rebinding** is best-effort, not airtight (see fetch notes above).
- **`re2` not pinned in.** User regexes go through a heuristic ReDoS
  filter and length cap, not a fully safe regex engine. A determined
  attacker can probably craft a pattern that slips through both checks;
  catastrophic backtracking still hangs only one worker, not the whole
  process.
- **Tool output is trusted on the way back.** A malicious file in the
  repo, or a tampered MCP response, can carry prompt-injection content
  that the next LLM turn might act on. The user is the last line of
  defense via the `confirm` permission prompt.

## When in doubt

The two rules that keep things safe:

1. **Adversarial in, friendly out.** Validate every value that originated
   from the LLM, the network, or a third-party MCP server. Friendly
   internal callers don't need validation.

2. **Match the scope of authorization to the scope of action.** A `trust`
   entry for `bash:git status` should not auto-allow `bash:rm -rf /`. The
   policy escapes glob metacharacters and uses `subjectKey` to enforce
   this; new tools should declare `subjectKey` rather than rely on the
   policy's fallback heuristic.

## See also

- [CHANGELOG.md](CHANGELOG.md) — security-relevant changes by version
- [README.md](README.md) — usage and configuration
