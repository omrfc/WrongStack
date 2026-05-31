# Security Report — WrongStack

**Target:** WrongStack monorepo (AI coding-agent CLI) · TypeScript / Node ≥ 22 · pnpm
**Scan date:** 2026-05-31
**Pipeline:** security-check 4-phase (Recon → Hunt → Verify → Report)
**Scope:** full source audit of `packages/*` + `apps/*` (710 source files, 13 packages), dependencies, CI/CD, build scripts.

---

## Executive summary

WrongStack is, on the whole, a **security-conscious and well-hardened codebase**.
The high-risk surfaces an agentic CLI is judged on — the SSRF guard, the local
WebUI control plane, the encrypted secret vault, dependency hygiene, and CI/CD —
are all in good shape and stood up to focused attack. Most "obvious" vulnerability
classes (prototype pollution, dynamic code evaluation, command injection in the
shell wrappers, hardcoded secrets, Actions script injection) were checked and
**ruled out**.

The audit surfaced **one HIGH-severity issue** — an argument-injection flaw in the
`diff` tool that yields an *unconfirmed, out-of-root arbitrary file write* reachable
by prompt injection alone — plus **two MEDIUM authorization gaps** in the
plugin-trust and subagent-permission models that share a single root cause:
**authorization is decided by tool-name strings rather than by capability or
officiality**, and the relevant lists are denylists/opt-in rather than allowlists.

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 0 | — |
| High | 1 | F-01 |
| Medium | 2 | F-02, F-03 |
| Low | 6 | F-04, F-05, F-06, F-07, F-08, F-10 |
| Low/Info | 2 | F-07*, F-09 |
| Informational | 4+ | see verified-findings.md |

**Overall risk: MODERATE.** Driven almost entirely by F-01 (a concrete, no-confirm
write primitive) and its interaction with F-03. Fixing F-01 and F-03 removes the
exploitable path; F-02 is a hardening/consistency fix.

> **Remediation status (2026-05-31):** F-01–F-07 **FIXED** in this session, each
> with regression tests (full `core`+`tools`+`mcp`+`runtime`+`cli` suites green:
> 3957 passed; workspace typecheck + Biome clean). Residual **MODERATE→LOW**.
> F-08/F-09/F-10 intentionally **not changed** — see notes below.

| ID | Status | Change |
|----|--------|--------|
| F-01 | ✅ Fixed | `diff.ts` rejects `a`/`b` refs beginning with `-` (unconditional, before `findGitDir`). |
| F-02 | ✅ Fixed | `api.ts` gates `tools.wrap`/`unregister` by ownership; only official plugins may touch tools they don't own. |
| F-03 | ✅ Fixed | subagent guard now denies `edit`/`replace` and all `mcp__*` tools (fail-closed). |
| F-04 | ✅ Fixed | `read`/`edit`/`write` use `safeResolveReal` (realpath containment, CWE-59). |
| F-05 | ✅ Fixed | `fetch.ts`'s SSRF guard exported as `guardedFetch`; `search.ts` routed through it (manual redirects + per-hop private-IP revalidation). |
| F-06 | ✅ Fixed | `DefaultSessionStore` accepts a `secretScrubber`; `user_input`/`llm_response` content (and the summary title) scrubbed before persistence. Wired in the runtime container. |
| F-07 | ✅ Fixed | MCP `validateTransportUrl` gains IPv6 parity (link-local `fe80::/10` + AWS IPv6 IMDS `fd00:ec2::254`). |
| F-08 | ↩︎ Won't fix | The session soft-allow/deny exact-match is *stricter* than the trust-file glob match — current behavior is the safer one; "aligning" it would loosen it. Not a vulnerability. |
| F-09 | ↩︎ Maintainer call | `postinstall` git-hooks setup is a dev-ergonomics choice (local config on the contributor's own machine), not a security boundary. |
| F-10 | ↩︎ Maintainer call | `--no-git-checks` on the local `release` script may be intentional (version-bump-then-publish); authoritative release path is the clean-checkout CI. Left to the maintainer. |

---

## Scan statistics

- Languages detected: TypeScript/JavaScript (primary). No Go/Python/PHP/Rust/Java/C#.
- Infra: no Dockerfiles/K8s/Terraform. 3 GitHub Actions workflows (ci, pages, release).
- Hunters dispatched (parallel): 6 — FS/cmdi, SSRF/WebUI, secrets/crypto, RCE/deser, authz/permissions, deps/CI-CD.
- `pnpm audit`: **0 advisories** across 591 resolved dependencies.
- Findings raised: ~18 · verified as real (Low+): 10 · false-positives/out-of-scope eliminated: 8.

---

## Findings by severity

### 🔴 HIGH

#### F-01 — `diff` tool argument injection → unconfirmed arbitrary file write
- **CWE-88 / CWE-22** · `packages/tools/src/diff.ts:34,77-78`
- **CVSS v3.1 (est.):** 8.1 — `AV:L/AC:L/PR:N/UI:N/S:C/C:N/I:H/A:H` (local agent
  process, no confirmation, scope change: writes outside the project sandbox).
- Model-controlled `a`/`b` refs flow unvalidated into `git diff` argv before `--`.
  The tool is `permission: 'auto'`, so `a = "--output=<anypath>"` writes the diff
  to an arbitrary path **with no user confirmation and outside the project root**
  (git's `--output` is not constrained by `safeResolve`). Reachable by prompt
  injection alone; also bypasses the subagent guard (F-03). Confirmed empirically.
- **Fix:** reject `a`/`b` beginning with `-`, or place them after a `--` boundary
  (mirror `git.ts`'s `validateWorktreeInput`). **One-line guard.**

### 🟠 MEDIUM

#### F-02 — Tool registry `wrap`/`unregister`/`override` lack trust-tier enforcement
- **CWE-863 / CWE-285** · `plugin/api.ts:110-116`, `registry/tool-registry.ts:80-123`, `plugin/loader.ts:328-342`
- **CVSS v3.1 (est.):** 5.5 (capped — requires an installed plugin, which already
  has in-process code execution; this is defense-in-depth + consistency with the
  slash-command registry that *does* enforce officiality).
- An external plugin can `api.tools.wrap('bash', …)` to downgrade a builtin's
  permission, or `unregister` a safeguard. The capability proxy only covers
  `register`, only when self-declared, and defaults to warn-not-enforce.
- **Fix:** apply the officiality gate to all mutating registry methods; extend the
  proxy beyond `register`; default `enforceCapabilities: true`.

#### F-03 — Subagent auto-approve guard is an incomplete denylist (fails open)
- **CWE-862 / CWE-863** · `security/permission-policy.ts:333-353`
- **CVSS v3.1 (est.):** 6.3 (`AV:L/AC:L/PR:N/UI:N/S:U/C:L/I:H/A:L` — prompt-injected
  subagent performs unconfirmed in-project file mutation).
- DENY = `{bash, write, scaffold, patch, install, exec}` omits `edit`, `replace`,
  `diff` (the F-01 write primitive), and **all `mcp__*` tools** — all auto-approved
  in delegated subagents. Denying `write` but allowing `edit` is an inconsistency,
  not a boundary.
- **Fix:** switch to an allowlist, or deny on `tool.mutating === true`; gate
  `mcp__*` by default.

### 🟡 LOW
- **F-04** Symlink not resolved in `read`/`edit`/`write` path containment (CWE-59).
- **F-05** Builtin `search` follows redirects without per-hop private-IP re-check (CWE-918, fixed host).
- **F-06** `user_input`/`llm_response` persisted to session JSONL unscrubbed (CWE-532).
- **F-07** MCP transport URL validation lighter than `fetch.ts` (CWE-918, config-gated).
- **F-08** Session allow/deny exact-match vs trust-file glob-match divergence (CWE-863, fails closed).
- **F-10** `release`/`release:dry` use `--no-git-checks` (manual-misuse only).

### ⚪ INFORMATIONAL
- **F-09** `postinstall` silently sets `core.hooksPath`. Logger doesn't scrub.
  Dead `redactUrl` in telegram. Unsandboxed npm-plugin import (by design).
  Stale `better-sqlite3` build allow-list entry. (See `verified-findings.md`.)

---

## What was checked and found solid (notable)

- **SSRF guard (`tools/fetch.ts`)** — DNS-pinned undici dispatcher closes the
  rebinding TOCTOU; blocks loopback/RFC1918/link-local/CGNAT/IMDS for both IPv4 &
  IPv6; re-validates every redirect hop; HTTPS-only by default. Reference-grade.
- **WebUI control plane** — `127.0.0.1` bind, per-process random token +
  `timingSafeEqual`, **Host-header + Origin checks** (defeat DNS-rebinding and
  cross-site WebSocket hijack), strict CSP, rate limiting. Not drivable from a
  malicious web page.
- **Secret vault** — AES-256-GCM, fresh random IV per encrypt, GCM tag validated,
  `0o600` key with exclusive `wx` create, atomic config writes. Crypto is correct.
- **Prototype pollution** — the two merge sites touching untrusted on-disk data
  both carry `FORBIDDEN_PROTO_KEYS`; tool-input parsing can't pollute (verified).
- **Supply chain / CI/CD** — 0 audit advisories; SHA-pinned third-party actions;
  least-privilege `GITHUB_TOKEN`; provenance-signed publish gated to tags; no
  Actions script injection; `--frozen-lockfile` everywhere.

---

## Remediation roadmap

**Phase 1 — fix now (closes the exploitable path):**
1. **F-01** — add the leading-dash guard to `diff.ts` `a`/`b` (highest priority; trivial).
2. **F-03** — make the subagent guard an allowlist or `mutating`-based deny; this
   also neutralizes F-01 inside subagents and any future `auto` write tool.

**Phase 2 — harden the trust model (next sprint):**
3. **F-02** — enforce officiality on `wrap`/`unregister`/`override`; broaden the
   capability proxy; flip `enforceCapabilities` default to `true`.
4. **F-04** — add `realpath` cross-check to single-file `read`/`edit`/`write`
   (the pattern already exists in `replace.ts`/`grep.ts`).

**Phase 3 — data-at-rest & egress polish:**
5. **F-06** — scrub at the session-writer boundary. **F-05/F-07** — route `search`
   and MCP http/SSE through the `fetch.ts`-grade guard.

**Phase 4 — housekeeping:**
6. **F-08/F-09/F-10** + informational items — consistency, gating, dead-code removal.

---

*Full per-finding analysis with data-flow and reproduction: `verified-findings.md`.
Raw hunter output: `sc-fs-cmdi-results.md`, `sc-ssrf-webui-results.md`,
`sc-secrets-crypto-results.md`, `sc-rce-deser-results.md`, `sc-authz-perm-results.md`,
`sc-deps-cicd-results.md`.*
