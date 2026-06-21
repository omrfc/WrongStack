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
- **Capability-based gating** (2026-06-13): tools declare `capabilities`
  (e.g. `['fs.write']`, `['net.outbound']`). The `AutoApprovePermissionPolicy`
  uses these to allowlist by *what a tool can do* rather than by *what it is
  called*. This prevents a renamed tool from bypassing trust rules.

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

### Plugin tool mutation boundary

[packages/core/src/plugin/api.ts](packages/core/src/plugin/api.ts)

- **Capability-based mutation authorization** (2026-06-13): plugins can only
  wrap or unregister tools they don't own if they declare matching capabilities
  in `toolMutateCapabilities`.
- **Official plugins bypass** — first-party plugins bundled with WrongStack are
  trusted and can mutate any tool.
- **Tool owners bypass** — a plugin can always mutate its own registered tools.
- **External plugins are restricted** — if a tool declares `capabilities:
  ['fs.write']`, an external plugin must list `'fs.write'` in its
  `toolMutateCapabilities` to wrap or unregister it. No overlap = mutation
  denied with a clear error message.
- **No-capability tools are immutable** — tools without a `capabilities`
  array cannot be mutated by external plugins at all. This is a safe default:
  legacy tools are protected until explicitly tagged.

### HQ command center (Phase 1)

`wstack --hq` starts a project-independent command center on a single HTTP /
WebSocket port (default `3499`). It accepts telemetry from local WrongStack
clients (TUI / REPL / WebUI / brain mailbox / agent-loop checker mailbox)
and serves a self-contained dashboard at `/`. The implementation lives in
[`packages/cli/src/hq-server.ts`](packages/cli/src/hq-server.ts); the
protocol types live in
[`packages/core/src/hq/protocol.ts`](packages/core/src/hq/protocol.ts) and
the publisher in
[`packages/core/src/hq/publisher.ts`](packages/core/src/hq/publisher.ts).
The full deployment plan is in
[`docs/plans/hq-command-center-2026-06.md`](docs/plans/hq-command-center-2026-06.md).

**Threat model.** HQ receives developer-machine telemetry and may
eventually expose control commands. Treat it as sensitive infrastructure
even though Phase 1 is read-only. The HQ channel carries, at minimum:

- `clientId`, `machineId`, `hostname`, `pid`, `version`, `startedAt`
  (`HqClientIdentity`),
- `projectRoot`, `projectName`, `gitRemote`, `gitBranch` (`HqProjectIdentity`),
- session / fleet / worklist / git state,
- mailbox message summaries (subjects, previews, agent identity, status)
  — **never raw bodies** unless `WRONGSTACK_HQ_RAW_CONTENT=1` is set,
- tool names, durations, costs, error classes — **never raw tool inputs /
  outputs / files** by default,
- everything is redaction-passed before publish
  ([`packages/core/src/hq/redaction.ts`](packages/core/src/hq/redaction.ts)):
  paths are project-relative, tool args are summarized, raw prompt /
  output / file / log fields are dropped unless `rawContent: true`,
  secret patterns are scrubbed via `DefaultSecretScrubber`.

**Defaults (Phase 1).**

- Bind to `127.0.0.1` by default (configurable via `--host`, defaults to
  loopback in `cli-main.ts:173`).
- Protocol version is negotiated — `payload.protocolVersion !==
  HQ_PROTOCOL_VERSION` closes the socket with WebSocket close code `1008`
  (`hq-server.ts:806-808`).
- Frame size is capped at 1 MiB (`WebSocketServer({ maxPayload: 1 * 1024 *
  1024 })`, `hq-server.ts:715`).
- Client identity is verified only via `client.hello.client.clientId` —
  there is no challenge / response or token exchange yet.
- Browser channel is unauthenticated in Phase 1 — any web page that can
  reach the port can open a `/ws/browser` socket and read the global
  snapshot.
- Client channel is unauthenticated — any process that can reach the
  port can publish telemetry under any `clientId` / `projectId`.

**Phase 1 non-goals (now partially shipped in Phase 2/3).**

- ✅ **shipped (Phase 3)**: opt-in browser token auth on `/ws/browser`
  (TOKEN MODE — see `wstack hq token create`).
- 📋 **still planned**: authentication on `/ws/client` (any frame is
  accepted today).
- 📋 **still planned**: CORS / origin enforcement.
- 📋 **still planned**: rate limiting on HTTP endpoints or WebSocket frames.
- 📋 **still planned**: TLS termination (HQ speaks plain HTTP/WS;
  reverse-proxy it).
- 📋 **still planned**: audit log of who connected, when, and from which IP.
- 📋 **still planned**: persistence of client / browser state beyond the
  process lifetime (`<dataDir>/events.jsonl` schema reserved).

See [HQ command center — Remote / relay deployment](docs/subcommands/hq.md#remote--relay-deployment)
for what is and is not safe to expose today, and the
[Phase 2+ roadmap](#hq-phase-2-auth-roadmap) below for the planned
controls.

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
- **Session soft-deny state is in-memory only.** The permission policy
  tracks per-session soft-denies (`sessionDenied` / `sessionAllowed` maps)
  to let a user approve or deny once and have that decision apply for the
  retry loop within the same session. This state is intentionally not
  persisted — it is discarded on clean exit and on process crash. If the
  agent restarts mid-session (crash, `wrongstack restart`, leader
  election), the user may be re-prompted for decisions they already made.
  This is a deliberate UX trade-off to avoid polluting the persisted
  trust file with transient session decisions.
- **Tool output is trusted on the way back.** A malicious file in the
  repo, or a tampered MCP response, can carry prompt-injection content
  that the next LLM turn might act on. The user is the last line of
  defense via the `confirm` permission prompt.
- **HQ command center browser auth is opt-in (token mode).** See
  [HQ command center (Phase 1)](#hq-command-center-phase-1) and the
  [Phase 2+ auth roadmap](#hq-phase-2-auth-roadmap). By default the
  server runs in OPEN MODE (all `/ws/browser` connections accepted); run
  `wstack hq token create` to enter TOKEN MODE. Browser password auth,
  `/ws/client` token validation, CORS, origin, and rate-limit controls
  are not yet shipped — do not expose `--host 0.0.0.0` on a public VPS or
  any network you do not fully trust until those land.

### Accepted risks & deliberate trade-offs (from 2026 security audits)

The following items were reviewed during the May and June 2026 `security-check`
audits and explicitly accepted as non-blocking:

- **Postinstall git-hooks setup** (`"postinstall": "git config core.hooksPath .githooks"` in root package.json):
  - This only affects developers who clone the repo. It is not a runtime security boundary.
  - Listed as "maintainer call / won't fix" in both audits. Changing it would harm contributor experience with no meaningful security gain for end users.

- **Some remaining name-string + denylist authorization checks** (e.g. `AutoApprovePermissionPolicy.DENY` and parts of plugin tool mutation rules):
  - These were pragmatic and effective, but have now been superseded by explicit capability allowlists (see **Capability-based gating** above and `docs/plans/security-hardening-2026-06.md` P1).
  - The old denylist checks remain as defense-in-depth but are no longer the primary control.

- **`onlyBuiltDependencies` allowlist maintenance**:
  - The current small allowlist (`@biomejs/biome`, `better-sqlite3`, `esbuild`) is intentionally strict. Any addition requires security review. This is tracked as an ongoing discipline item rather than a vulnerability.

Future scans should treat the above as **known and accepted** rather than new findings.

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

## HQ Phase 2+ auth roadmap

The HQ plan
([`docs/plans/hq-command-center-2026-06.md`](docs/plans/hq-command-center-2026-06.md))
specified the following controls for Phase 2+. Phase 2 and Phase 3 have
landed in slices (v0.275.0 / v0.276.0); the remaining controls are
planned for later Phase 2 / Phase 4 slices. Each subsection below is
marked **shipped**, **partial**, or **planned**.

### Browser auth

**Planned** — not yet shipped.

- Local loopback can bootstrap a browser session automatically.
- Remote browser access requires password login.
- Password hash stored with a slow KDF (`scrypt`, or `argon2` if already
  available and approved).
- Issue an HTTP-only session cookie for browser access.

```bash
wstack --hq --password             # prompt / set password on first run
wstack hq auth set-password        # rotate password
wstack hq auth reset               # revoke all browser sessions
```

> **What shipped instead (v0.276.0):** browser **token mode**. When
> `auth.json` carries one or more `browserTokens`, browsers must append
> `?token=<full-token>` to `/ws/browser`. Unknown/missing tokens are
> rejected at the HTTP layer (401) before the WS handshake. Token mode
> covers the immediate case of "let a teammate open the dashboard without
> exposing it publicly"; password auth (below) covers multi-tenant /
> unattended deployments.

### Client auth (enrollment tokens)

**Partial** — schema + publisher plumbing shipped (Phase 1); browser
token lifecycle shipped (Phase 3); `/ws/client` token validation is
planned.

Clients should use enrollment tokens, not the browser password. Tokens
are distinct from browser cookies so a stolen browser cookie cannot be
reused to publish telemetry.

```bash
wstack hq token create --name laptop-tui   # ✅ shipped (v0.276.0)
wstack hq token list                       # ✅ shipped (v0.276.0)
wstack hq token revoke <id>                # ✅ shipped (v0.276.0)
```

Token storage:

```text
~/.wrongstack/hq/auth.json   # ✅ shipped (v0.275.0, v0.276.0)
```

Token model:

- ✅ **shipped**: generated random token, shown once at creation; `id`,
  `label`, `createdAt`, `lastUsedAt`; operator passes the raw token via
  `?token=…` on `/ws/browser`.
- 🚧 **partial**: server stores the raw token today (mode `0o600`,
  atomic write). Hashing with a slow KDF is planned to harden at-rest
  storage.
- 📋 **planned**: `/ws/client` token validation (today `/ws/client` is
  exempt — any frame is accepted). Capability scope
  (`telemetry.publish`, `control.receive`) and `expiresAt` land with it.

### Frame & endpoint hygiene

**Planned** — none of these have shipped.

- Rate-limit WebSocket frames and HTTP endpoints (token bucket per IP,
  per channel).
- Tighten `maxPayload` per route (1 MiB today; mailbox snapshots could
  justify a separate larger cap).
- Add an audit log of `connect` / `disconnect` / `auth_fail` / `token_used`
  events with `clientId`, `projectId`, IP, and timestamp.
- Reject messages that exceed the redaction policy (e.g. raw tool args
  arriving despite `rawContent: false`).

### Persistence

**Partial** — `--data-dir` + `auth.json` shipped; event log + snapshot
cache planned.

- ✅ **shipped** (v0.275.0): `--data-dir <path>` flag (default
  `~/.wrongstack/hq`, honors `WRONGSTACK_HOME` / `WRONGSTACK_HQ_DATA_DIR`)
  for auth state.
- 📋 **planned**: retention knobs (default keep `MAX_EVENT_LOG = 500`
  events in memory; configurable TTL or size cap).
- 📋 **planned**: persistent event log (`<dataDir>/events.jsonl`) and
  snapshot cache (`<dataDir>/snapshot.json`) so a server restart
  preserves recent history. Schema reservation is already in place.

### TLS / deployment

**Planned** — unchanged from Phase 1 posture.

- HQ itself stays plain HTTP/WS. TLS terminates in front via Cloudflare
  Tunnel or an HTTPS reverse proxy.
- When `WRONGSTACK_HQ_URL` is `https://…` or `wss://…`, the publisher's
  `toClientUrl()` rewrites the scheme automatically; no client-side
  changes needed.
- Cloudflare Access can be layered in front, but does **not** replace
  client enrollment tokens on `/ws/client`.

### Flags & subcommands

| Flag / subcommand | Status |
|---|---|
| `--password` | 📋 planned |
| `--data-dir <path>` | ✅ shipped (v0.275.0) |
| `wstack hq` / `wstack hq serve` | ✅ shipped (v0.276.0) |
| `wstack hq auth set-password` | 📋 planned |
| `wstack hq auth reset` | 📋 planned |
| `wstack hq token create --name <label>` | ✅ shipped (v0.276.0) |
| `wstack hq token list` | ✅ shipped (v0.276.0) |
| `wstack hq token revoke <id>` | ✅ shipped (v0.276.0) |

### Live token reload

**Planned** — the server reads `auth.json` once at startup today. Run
`wstack hq` (or `wstack --hq`) again after creating or revoking tokens
for the change to take effect. Phase 4 will add a file-watcher.

Until browser password auth and client token validation land, the
supported deployment is: loopback on the developer's own machine,
optional LAN exposure on a trusted network, with any TLS / tunnel
handled by an external proxy that does not forward unauthenticated
traffic from the public internet.

## See also

- [CHANGELOG.md](CHANGELOG.md) — security-relevant changes by version
- [README.md](README.md) — usage and configuration
- [docs/plans/hq-command-center-2026-06.md](docs/plans/hq-command-center-2026-06.md) — HQ command center architecture and phased plan (Access Control section)
- [docs/subcommands/hq.md](docs/subcommands/hq.md) — `wstack --hq` user command reference (flags, routes, env vars, deployment)
