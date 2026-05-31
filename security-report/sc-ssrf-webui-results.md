# SSRF / WebUI Control-Plane / Network Egress Audit

Scope: SSRF (CWE-918), the local WebUI HTTP/WebSocket server (auth, CORS, CSRF,
origin checks, command surface), Open Redirect, WebSocket security, and network
egress. Reference standard: `packages/tools/src/fetch.ts` (DNS-pinned undici
dispatcher, private/loopback/link-local v4+v6 blocking incl. 169.254.169.254,
redirect re-validation, HTTPS-only).

Audited 2026-05-31. Authorized defensive audit of the user's own repo.

---

## Summary verdict

**The WebUI control plane is well-hardened and not exploitable from a malicious
web page** under the default loopback bind. Both WebUI server implementations
(`packages/cli/src/webui-server.ts` and `packages/webui/src/server/index.ts`)
bind to `127.0.0.1` by default, generate a per-process random auth token, and —
crucially — enforce a **loopback `Host`-header check that defeats DNS rebinding**
plus an **`Origin` check that defeats cross-site WebSocket hijacking (CSWSH)**.
A page on `evil.com` that rebinds DNS to 127.0.0.1 still sends `Host: evil.com`
and `Origin: https://evil.com`, both of which are rejected before any message
is processed.

All audited network-egress call sites either (a) go through `fetch.ts`-grade
SSRF guards, or (b) target a **fixed, hardcoded, TLS host** (`api.github.com`,
`api.telegram.org`, `registry.npmjs.org`, search engines) where the host is not
attacker-controlled. The MCP transport applies a lighter (admin-config-only)
URL validation that is documented and appropriate for its trust model.

No High/Critical findings. Findings below are Low/Informational hardening notes.

---

## Findings

### F-1 (LOW) — `search` builtin tool follows redirects without re-validation

- **CWE:** CWE-918 (SSRF, redirect-based)
- **Severity:** Low
- **File:** `packages/tools/src/search.ts:91-223` (`duckduckgoSearch`/`googleSearch`/`bingSearch` → `fetchWithTimeout` at `:253`)
- **Data flow:** The builtin `search` tool (`permission: 'confirm'`, registered
  in the default tool pack) builds a fixed URL against `lite.duckduckgo.com`,
  `www.google.com`, or `www.bing.com` with the user query URL-encoded into the
  query string. `fetchWithTimeout` calls global `fetch(url, …)` with the default
  `redirect: 'follow'` and **no URL validation and no per-hop re-validation**.
  The initial host is fixed and trusted (TLS), so the attacker does not control
  the destination host directly. The residual risk is purely a 3xx from one of
  those search engines to an internal address — these engines are TLS-protected
  and do not redirect to RFC1918 space, so practical exploitability is near zero.
- **Contrast:** The separate `web-search` plugin (`packages/plugins/src/web-search/index.ts`)
  has a full SSRF guard for its `web_fetch` tool (`assertSafeUrl` + manual
  redirect loop with per-hop re-validation, `:115-166`). The builtin `search`
  tool does not — an inconsistency worth closing for defense-in-depth.
- **Remediation:** Use `redirect: 'manual'` in `fetchWithTimeout` and reject any
  3xx whose `Location` resolves to a private/loopback/link-local address (reuse
  the `assertSafeUrl`/`isPrivateIPv4`/`isPrivateIPv6` logic already present in
  the web-search plugin or `fetch.ts`). Low priority because the host is fixed.

### F-2 (INFO) — `web_search` tool has `permission: 'auto'` while `web_fetch` is `confirm`

- **CWE:** CWE-918 (informational)
- **Severity:** Informational
- **File:** `packages/plugins/src/web-search/index.ts:253` (`web_search`, `permission: 'auto'`)
- **Note:** `web_search` calls `duckduckgoSearch` (`:32-67`) which fetches a
  fixed DuckDuckGo HTML host with no SSRF guard, but the host is fixed and the
  query is URL-encoded into the query string only, and `redirect` is default.
  Same residual redirect risk as F-1 but lower impact (it only parses result
  links, does not fetch them). The `web_fetch` tool that actually fetches
  arbitrary user URLs is correctly `permission: 'confirm'` and fully guarded.
  No action required; documented for completeness.

### F-3 (INFO) — MCP HTTP/SSE transport uses lighter URL validation than fetch.ts

- **CWE:** CWE-918 (informational / by-design)
- **Severity:** Informational
- **File:** `packages/mcp/src/transport.ts:46-90` (`validateTransportUrl`)
- **Data flow:** `SSETransport` and `StreamableHTTPTransport` connect to a
  config-supplied MCP `url` via global `fetch`. `validateTransportUrl` enforces
  http/https only, blocks the `169.254.0.0/16` IMDS range for IPv4 literals, and
  requires TLS for non-loopback hosts. It deliberately does **not** do DNS
  resolution + full private-range blocking like `fetch.ts` (documented at
  `:42-45`: "MCP URLs are admin-configured, not LLM-supplied"). It also does not
  re-validate the host after the initial connect, and `redirect` is left at the
  fetch default. Because the MCP server URL comes from machine-local config
  (not from the model or a web page), this is an acceptable trust model — an
  attacker who can edit MCP config already has local code execution. The
  `169.254` block only covers IPv4 literals; a hostname resolving to an
  internal IP or an IPv6 IMDS literal (`fd00:ec2::254`) is not blocked, but
  again this requires config control. **No change required**; if hardening is
  desired, route MCP HTTP transports through the same DNS-pinned dispatcher used
  by `fetch.ts`.

---

## What was checked and found clean

### WebUI control plane — both implementations (PRIMARY TARGET)

**`packages/cli/src/webui-server.ts`** (embedded WebUI, single WSS):
- Binds `host: '127.0.0.1'` only (`:63`). Not 0.0.0.0.
- Per-process random 16-byte hex auth token (`:61`); never logged.
- `maxPayload: 1 MiB` (`:63`); per-connection rate limit 60 msg / 60 s (`:285-301`).
- On `connection` (`:216-279`): **Host-header loopback check (DNS-rebinding
  defense, `:241-251`)**, **Origin check requiring loopback-or-token (CSWSH
  defense, `:253-275`)**, non-browser clients require token (`:266-274`).
  Constant-time token compare via `crypto.timingSafeEqual` (`:225-230`).
- Command surface is limited: `user_message` (runs the agent), `abort`, `ping`,
  provider/key CRUD. Keys are encrypted at rest via `DefaultSecretVault`
  (`:727-768`, mode `0o600`). Concurrent-run guard prevents context corruption
  (`:433-439`).

**`packages/webui/src/server/index.ts`** (standalone `webui` binary, richer
surface incl. autophase/worktree):
- Default bind `127.0.0.1` (`:83`), optional `::1` secondary loopback listener
  (`:534-542`). Operator opt-in to LAN via `WS_HOST` (`entry.ts:6`).
- Per-process random token (`:444`), masked in logs (`:447`).
- `verifyClient` (`:488-524`) is attached to **both** WSS listeners
  (`:531`, `:539`) and runs the Host-header guard first (`hostHeaderOk`,
  `:473-486`), then Origin (`:513-523`), then token. On a `0.0.0.0` bind a token
  is mandatory for non-loopback peers (`:510`). Tested in
  `packages/webui/tests/server/ws-auth.test.ts` (rebinding, cross-origin,
  wrong-token, malformed-origin cases).
- `maxPayload: 8 MiB` (`:527`), rate limit 60/60s keyed on sessionId
  (`:549-566`), **prototype-pollution guard** on inbound JSON (`:748-759`).
- HTTP static file server (`:1981-2052`): path-traversal guard against
  `DIST_DIR` (`:1996-2005`), strict CSP with **explicit loopback `connect-src`**
  (no bare `ws:`/`wss:`) on both the direct and SPA-fallback branches
  (`:2020-2021`, `:2040`), `X-Frame-Options: DENY`, `nosniff`, `frame-ancestors
  'none'`. No `Access-Control-Allow-Origin` header is set anywhere (no CORS
  surface; it serves its own SPA only).
- **Autophase command surface** (`autophase-ws-handler.ts`): `autophase.start`
  launches a fully autonomous agent run (bash/write tools) — a powerful
  capability — but it is reachable **only after** passing `verifyClient`, so a
  cross-site/rebinding page cannot reach it. Same for worktree handler
  (read-only event mirror, no command surface).
- `ws-client.ts`: forces literal `127.0.0.1` for loopback page hosts to avoid
  IPv6 flap; stores token in `sessionStorage` and replays as `?token=` on
  reconnect (`:101-105`).

### Egress to fixed, hardcoded hosts (host not attacker-controlled)

- `packages/core/src/storage/cloud-sync.ts:210` — `https://api.github.com/repos/${owner}/${repo}...`;
  owner/repo come from `cfg.repo` (user config), interpolated as **path
  segments** of the fixed GitHub host, not the host. Bearer token in header. Clean.
- `packages/core/src/skills/github-fetcher.ts:50` — `https://api.github.com/repos/.../tarball/${ref}`;
  fixed host, path-segment interpolation. Has tarball size cap (`:75-80`) and a
  zip-slip guard in the tar extractor (`:139-149`, symlinks skipped). Clean.
- `packages/telegram/src/bot.ts:113` — `https://api.telegram.org/bot${token}`;
  fixed host. Token redacted in logs (`:8-10`). 10s timeouts. Clean.
- `packages/cli/src/update-check.ts:91` — `https://registry.npmjs.org/wrongstack/latest`,
  fully static URL, 3s timeout, 24h cache. Clean.

### Local servers binding loopback by default

- `packages/core/src/observability/prometheus.ts:139-142` — metrics/health HTTP
  server defaults to `host: '127.0.0.1'`; GET-only; operator opts into `0.0.0.0`
  explicitly (documented re: prompt-content leakage via labels). Clean.

### Reference confirmed

- `packages/tools/src/fetch.ts:280-339` — DNS-pinned dispatcher pre-flight +
  full v4/v6 private-range blocking (incl. IMDS, CGNAT, IPv4-mapped IPv6, octal/
  hex rejection via `net.isIP`). This is the standard the above is measured
  against.

---

## Severity rollup

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 (F-1) |
| Informational | 2 (F-2, F-3) |
