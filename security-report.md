# WrongStack — Security Scan Report

**Scan Date:** 2026-05-26
**Project:** WrongStack
**Scanner:** Automated security scan via WrongStack security-scanner skill
**Scope:** Full monorepo — packages/core, packages/cli, packages/tools, packages/providers, packages/mcp, packages/runtime, packages/plugins, packages/tui, packages/webui, packages/telegram, packages/acp, packages/plug-lsp

---

## Executive Summary

The WrongStack codebase demonstrates a **strong security posture**. The project has been hardened against prompt-injection attacks, secret exfiltration, and supply-chain risks through multiple layers of defense. No critical or high-severity vulnerabilities were found.

The codebase ships with a detailed threat model (`SECURITY.md`), uses AES-256-GCM encryption for secrets at rest, enforces an allowlist-based shell execution environment, and implements a permission policy that prevents glob metacharacter injection in trust rules.

Two **medium-severity** and two **low-severity** findings were identified — all are documented known limitations or represent acceptable risk trade-offs clearly described in `SECURITY.md`.

**Total findings: 4**

---

## Findings by Severity

### 🔴 Critical — 0 findings

None.

---

### 🟠 High — 0 findings

None.

---

### 🟡 Medium — 2 findings

---

#### MEDIUM-1: Telegram `parse_mode: 'HTML'` enables HTML injection in messages

**Severity:** Medium
**File/Location:** `packages/telegram/src/bot.ts`, line 187
**Description:**
The Telegram bot sends messages using `parse_mode: 'HTML'`. When HTML parse mode is enabled, Telegram parses HTML tags (`<b>`, `<i>`, `<code>`, `<a href=…>`, etc.) in the message body. If user-supplied text is included in the message text without sanitization, an attacker who sends a specially crafted message to the bot could inject HTML elements into the response sent to other users (stored XSS equivalent within Telegram's client).

The bot does have allowlist controls (`allowedUsers`, `allowedChats`), which reduces but does not eliminate the risk — an allowed user could intentionally craft malicious HTML tags in a message that gets re-broadcast.

The `escapeHtml` helper exists (`packages/telegram/src/bot.ts` line 327) but is not applied to the incoming message `text` field before sending it through the HTML-parsed `sendMessage` API.

**Recommendation:**
Apply `escapeHtml` to user-controlled `text` fields before inclusion in HTML-parsed `sendMessage` calls:

```ts
text: escapeHtml(msg.text ?? ''),
```

Alternatively, switch to `parse_mode: 'MarkdownV2'` with appropriate escaping, or `"parse_mode": undefined` (plain text) to eliminate HTML parsing entirely.

---

#### MEDIUM-2: WebUI WebSocket server lacks built-in authentication

**Severity:** Medium
**File/Location:** `packages/webui/src/server/index.ts`
**Description:**
The WebUI backend starts a WebSocket server on port 3457 bound to `127.0.0.1` by default. The WebSocket connection is the sole mechanism for the browser-based UI to communicate with the backend. There is no WebSocket-level authentication (no token, no signed handshake) — authentication is expected to be handled by the WrongStack agent's own permission system and the user is assumed to be a local operator.

If a user accidently exposes port 3457 beyond localhost (via `WS_HOST=0.0.0.0` or a similar override), an unauthorized remote attacker could connect to the WebUI WebSocket and send/receive messages with the full WrongStack agent, effectively gaining agent-level access.

The CSP in `vite.config.ts` (`frame-ancestors 'none'`) and the `X-Frame-Options: DENY` header provide protection against clickjacking, but do not protect the WebSocket endpoint itself.

**Recommendation:**
Add a WebSocket handshake authentication token derived from a user-chosen password or the session token. The provider config or session store already handles provider credentials centrally — extending that to protect the WebSocket handshake is the most consistent approach.

Alternatively, document the risk in `SECURITY.md` as the existing "Known limitations / deliberate non-goals" section and ensure the default binding remains on loopback.

---

### 🟢 Low — 2 findings

---

#### LOW-1: `__DEV__: true` baked into WebUI production bundle

**Severity:** Low
**File/Location:** `packages/webui/vite.config.ts`, line 46–47
**Description:**
The Vite config defines `__DEV__: true` unconditionally for all builds:

```ts
define: {
  __DEV__: true,
},
```

In Vite's dev mode, `import.meta.env.DEV` is `true` and enables hot-module replacement, debugging hooks, and additional runtime checks. While Vite does not expose a true development-mode flag in production bundles by default, setting `__DEV__: true` explicitly could enable additional code paths that are otherwise reachable in the browser context.

This is a low risk because Vite's production build does not include HMR and most dev-specific code paths are gated behind `import.meta.env.DEV` (not `__DEV__`). However, if any future code adds dev-only logic gated on `__DEV__` rather than `import.meta.env.DEV`, the production bundle would have that logic active.

**Recommendation:**
Replace with a pattern that Vite can resolve to a constant at build time:

```ts
define: {
  __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
},
```

Or use Vite's built-in `import.meta.env.DEV` directly in source code instead of a custom `__DEV__` global.

---

#### LOW-2: Session soft-deny state not persisted across agent restarts

**Severity:** Low
**File/Location:** `packages/core/src/security/permission-policy.ts`, lines 39–47
**Description:**
The permission policy implements in-memory session-scoped soft-deny (`sessionDenied`) and soft-allow (`sessionAllowed`) maps. These allow a user to press `n` (deny once) or `y` (allow once) per tool+pattern and have that decision apply for retry loops within the same session without touching the persisted trust file.

However, if the agent process restarts mid-session (e.g., due to a crash, `wstack restart`, or a multi-agent leader election), this in-memory state is lost. The user may be prompted again for decisions they believe they already made.

The behavior is by design — the code intentionally does not persist session decisions to avoid polluting the trust file with temporary states — but it could create a confusing UX where a user denied a command, the agent restarts, and the same command is re-prompted.

**Recommendation:**
Document this behavior in `SECURITY.md` under "Known limitations" alongside the existing DNS rebinding and ReDoS entries. Alternatively, introduce a lightweight session-state file that is cleared on clean exit but survives process crashes (best-effort crash recovery for permission decisions).

---

## ℹ️ Informational — Positive Findings

The following items are not vulnerabilities but are documented for completeness and to affirm positive security decisions:

#### INFO-1: AES-256-GCM secret vault
`packages/core/src/security/secret-vault.ts` — API keys are encrypted at rest using AES-256-GCM with a per-project key file (mode `0o600`). The key is race-safe via exclusive-create flag `'wx'`. IVs and auth tags are both randomly generated per encryption.

#### INFO-2: No known vulnerable dependencies
`pnpm audit --audit-level=low` reports **no known vulnerabilities** across all packages in the monorepo.

#### INFO-3: No hardcoded secrets in source code
Extensive grep for API key patterns (Anthropic `sk-ant-*`, OpenAI `sk-*`, GitHub PATs `ghp_*`, Bearer tokens, Telegram bot tokens, JWTs `eyJ*`, etc.) yielded no matches. The `.gitignore` properly excludes `.env`, `.env.local`, and all `.wrongstack/` runtime artifacts from version control.

#### INFO-4: Comprehensive threat model documented
`SECURITY.md` describes the adversary model, all security controls, and known limitations in detail. This is a strong security engineering practice.

#### INFO-5: shell env sanitization
`packages/tools/src/bash.ts` and `packages/tools/src/_env.ts` sanitize the child process environment by allowlisting PATH, HOME, LANG, and stripping variables whose names contain TOKEN, SECRET, PASSWORD, AUTH, BEARER, COOKIE, PRIVATE, or KEY (with word-boundary matching). Provider API keys, GitHub PATs, and AWS credentials are not passed to shell subprocesses.

#### INFO-6: CSP policy in webui
`packages/webui/vite.config.ts` sets a restrictive Content-Security-Policy (`default-src 'self'`, no `unsafe-eval`, no external scripts, WebSocket restricted to `127.0.0.1:3457`), `X-Frame-Options: DENY`, and `Strict-Transport-Security`.

#### INFO-7: Global singleton `__DEV__` scoped to webui package only
The `__DEV__: true` define is in the `webui` package only, not applied to core libraries or other packages. Blast radius is limited.

---

## Summary Table

| Severity | Count | IDs                |
|----------|-------|--------------------|
| Critical | 0     | —                  |
| High     | 0     | —                  |
| Medium   | 2     | MEDIUM-1, MEDIUM-2 |
| Low      | 2     | LOW-1, LOW-2        |
| Info     | 7     | INFO-1 through INFO-7 |

---

## Recommendations (Priority Order)

1. **Immediately:** Apply `escapeHtml()` to user-supplied text in Telegram bot messages before sending with `parse_mode: 'HTML'`. (MEDIUM-1)
2. **Soon:** Add WebSocket handshake authentication to the webui server. At minimum, ensure the default loopback binding is documented as a security boundary. (MEDIUM-2)
3. **Low priority:** Fix `vite.config.ts` `__DEV__` define to use `NODE_ENV`-based conditional. (LOW-1)
4. **Low priority:** Document session soft-deny crash-recovery behavior. (LOW-2)

All other items are confirmed secure or are deliberate design decisions documented in `SECURITY.md`.

---

*This report was generated by an automated security scan. Findings labeled "Info" reflect positive security decisions and do not require remediation.*
