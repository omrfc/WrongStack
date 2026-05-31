# Security Audit — Secrets & Cryptography (CWE-798 / 327 / 326 / 330 / 200 / 532)

Scope: hardcoded secrets, crypto misuse, sensitive-data exposure (secrets leaking to logs,
session JSONL, telemetry, errors, providers/MCP/telegram/cloud-sync). Defensive audit of the
user's own repo at `D:\Codebox\PROJECTS\WrongStack`.

**Verdict: substantially clean.** The crypto is implemented correctly, the secret vault and config
write paths encrypt before persisting with `0o600`, the cloud-sync design does not exfiltrate the
encryption key, and the scrubber covers the tool-output sink that is most likely to carry secrets.
No real leaked credentials are committed. Findings below are low-severity / informational hardening
notes plus the verification of the key claims.

---

## Verified-correct (no action needed)

### Crypto — `packages/core/src/security/secret-vault.ts`
- AES-256-GCM (`aes-256-gcm`), 32-byte key, 12-byte IV, 16-byte tag. No ECB, no static IV.
- **IV randomness**: `randomBytes(12)` generated per `encrypt()` call (line 40) — no IV reuse. (CWE-330: OK)
- **Auth tag**: written on encrypt (`getAuthTag`), validated on decrypt (`setAuthTag` + `final()` throws
  on mismatch, lines 62-63). Length-checked before use (lines 58-59). (Tamper detection: OK)
- **Key at rest**: created with `mode: 0o600` and exclusive flag `'wx'` (line 93) — race-safe; loser of
  the create race re-reads. Wrong-size key throws instead of silently regenerating (protects existing
  ciphertext). (CWE-326/200: OK)
- **Key in repo**: `~/.wrongstack/.key` (`secretsKey` in `wstack-paths.ts:98`) is never committed and is a
  sibling *file* of `globalRoot`, not inside any synced subdirectory.

### Config write paths encrypt before persisting
- `packages/cli/src/auth-menu.ts:838-839` — `encryptConfigSecrets(...)` then `atomicWrite(..., {mode:0o600})`.
- `packages/cli/src/boot-config.ts:54` — `migratePlaintextSecrets()` runs on boot to upgrade legacy plaintext.
- `rewriteConfigEncrypted` / `migratePlaintextSecrets` (`secret-vault.ts`) both `atomicWrite` with `0o600`
  and call `restrictFilePermissions`. UI displays keys masked (`maskedKey`, auth-menu.ts).
- Secret-field detection (`isSecretField`) is a reasonable substring allowlist with `publickey` opt-out.
  `Object.create(null)` is used in the walkers to block prototype pollution (CWE-1321 mitigated), and
  `deepMerge` filters `__proto__`/`constructor`/`prototype`.

### Cloud-sync does NOT exfiltrate the encryption key
- `packages/core/src/storage/cloud-sync.ts` pushes user categories to a private GitHub repo over the REST
  API. The `settings` category maps to `paths.globalConfig` = `~/.wrongstack/config.json` (a single file,
  `wstack-paths.ts:97`), whose secret fields are stored **encrypted**.
- The AES key (`.key`) is not in `globalConfig`, `globalSkills`, `globalPrompts`, `globalMemory`, or
  `historyFile`, so it is never uploaded. Encrypted-config-to-private-repo is an acceptable design as long
  as the per-machine key stays local — which it does. (CWE-200: OK)
- The GitHub token is passed as a `Bearer` header only (line 214); never logged. API error text from
  GitHub is surfaced in thrown errors but does not contain the token.

### Scrubber covers the high-risk tool-output sink
- `packages/core/src/execution/tool-executor.ts`: tool output is scrubbed before it becomes the
  `tool_result` content (`executeTool`, lines 221-223) and before it is rendered. Tool exceptions are
  scrubbed too (lines 128, 156). Because the *scrubbed* `tool_result` is what the agent later writes to
  the session JSONL, secrets surfaced by tools (e.g. `printenv`, `cat .env`) are redacted before persistence.
- `DefaultSecretScrubber` (`secret-scrubber.ts`) covers Anthropic/OpenAI/GitHub/AWS/GCP/Slack/Stripe/Twilio/
  Telegram/JWT/PEM/DB-URI/Bearer/high-entropy-env patterns, chunks oversized input (64 KB), and the regexes
  use bounded quantifiers / alternation instead of catastrophic lookbehind (ReDoS-aware by design).

### Providers do not leak credentials in errors/logs
- `packages/providers/src/wire-adapter.ts`: auth headers (`x-api-key`, `Authorization: Bearer`,
  `x-goog-api-key`) are set per request but `ProviderError`/`translateError` carry only HTTP status +
  *response* body, never the request headers. Fetch-failure errors carry `err.message` only (no URL/headers).

### WebUI WebSocket auth token — crypto hygiene OK
- `packages/webui/src/server/index.ts:444` — `randomBytes(16)` (128-bit CSPRNG). Compared with
  `timingSafeEqual` (line 52 import, `tokenMatches`). Logged masked: `slice(0,4)…slice(-4)` (line 447).
  CSWSH/loopback guard present.

### No committed real secrets
Repo-wide scan for live key formats matched only:
- Test fixtures: `packages/core/tests/security/secret-scrubber.test.ts` (fabricated `sk-ant-api03-AbCd…`,
  `ghp_abc…`, etc.).
- The canonical AWS documentation placeholder `AKIAIOSFODNN7EXAMPLE` in
  `packages/core/skills/security-scanner/SKILL.md` and `packages/core/src/coordination/fleet.ts:176`.
- Doc snippet `-----BEGIN RSA PRIVATE KEY-----\nMIIE...` (truncated placeholder) in SKILL.md.

No `.env`, `.env.example`, or `config.sample.json` files are committed. (CWE-798: none found.)

---

## Findings

### F1 (Low / Informational) — Session JSONL persists `user_input` and `llm_response` unscrubbed
- **CWE**: CWE-532 (Insertion of Sensitive Information into Log File)
- **Severity**: Low
- **Location**: `packages/core/src/core/agent.ts:334-338` (`user_input`), `:640-646` (`llm_response`);
  written by `packages/core/src/storage/session-store.ts` `FileSessionWriter.append` (line 389) with no
  scrubbing.
- **Explanation**: `user_input` and `llm_response` events are written to
  `<projectDir>/.wrongstack/sessions/<id>.jsonl` verbatim. The JSONL is created mode `0o600`, so it is
  owner-only. This does **not** expose the agent's own provider credentials (those never appear in
  conversation content), but if a *user pastes a secret into the prompt* or a model echoes one, it is
  persisted in cleartext on disk and would also be uploaded by the `history` cloud-sync category. This is
  a deliberate design tradeoff (the conversation must round-trip for resume), and the tool-output sink —
  the most common secret source — *is* scrubbed.
- **Remediation (optional hardening)**: run `secretScrubber.scrub`/`scrubObject` over `content` of
  `user_input`/`llm_response` events at the `FileSessionWriter.append` boundary (or before
  `cloud-sync.buildLocalTree` reads the history file). Note this would also scrub the in-replay messages,
  so apply at the persistence boundary only, not to `ctx.messages`.

### F2 (Informational) — `DefaultLogger` does not scrub; it is a latent sink
- **CWE**: CWE-532
- **Severity**: Informational
- **Location**: `packages/core/src/infrastructure/logger.ts:74-99`
- **Explanation**: `DefaultLogger` writes `msg` + `ctx` (including `Error.stack`) to
  `~/.wrongstack/logs/wrongstack.log` and stderr with no redaction. Current callers reviewed
  (providers, telegram, session-store, sync-plugin) do not pass secrets, so there is no live leak. The
  risk is future callers logging a config object, request body, or `process.env`.
- **Remediation (optional)**: route `ctx`/`msg` through `secretScrubber.scrub`/`scrubObject` inside
  `DefaultLogger.log`, or document that callers must scrub before logging. Low priority given current usage.

### F3 (Informational) — Dead redaction helper in Telegram bot
- **CWE**: CWE-1164 (irrelevant code) — defense-in-depth gap, not an exposure
- **Severity**: Informational
- **Location**: `packages/telegram/src/bot.ts:7-10` (`redactUrl`, defined but never called)
- **Explanation**: `redactUrl` (strips the bot token from a URL) is unused. The bot's catch blocks
  currently log `(err as Error).message` and `data.description`, not the raw `baseUrl`, so the token is
  not currently logged. However, the helper's existence suggests an intent that isn't wired up — if a
  future change logs `url` or `this.baseUrl` on error, the token (embedded in
  `https://api.telegram.org/bot<TOKEN>/...`) would leak.
- **Remediation**: either delete the dead helper, or wire it into any error path that might surface the
  URL (e.g. wrap `url` with `redactUrl(url)` before logging). Also consider that some undici fetch errors
  include the request URL in their message — applying `redactUrl` to caught error messages before logging
  would close that path.

### F4 (False positive — documented) — `icacls` with `process.env.USERNAME` is not injectable
- **CWE**: CWE-78 (assessed, not present)
- **Severity**: None
- **Location**: `packages/core/src/security/secret-vault.ts:251`
- **Explanation**: `execFileAsync('icacls', [filePath, '/inheritance:r', '/grant:r',
  '${process.env.USERNAME}:(F)'])` uses `execFile`, which passes each array element as a literal argv
  entry with **no shell interpretation**. A `USERNAME` containing shell metacharacters cannot inject a
  command; at worst it produces a malformed icacls principal and the call fails (caught, warning logged).
  `USERNAME` is also only attacker-controlled by someone who already controls the user's environment.
  No fix required. (Cosmetic: quoting wouldn't help an argv element and isn't needed.)

---

## What was checked
- `security/secret-vault.ts`, `security/config-secrets.ts`, `security/secret-scrubber.ts`,
  `types/secret-vault.ts`, `types/secret-scrubber.ts`
- `storage/session-store.ts` (JSONL writer/summary), `storage/cloud-sync.ts`, config write paths
  (`cli/src/auth-menu.ts`, `cli/src/boot-config.ts`)
- `observability/tracer.ts`, `observability/otlp-traces.ts` (span attributes — no secrets), `metrics`,
  `prometheus` (not secret-bearing)
- `infrastructure/logger.ts`
- Providers: `wire-adapter.ts`, `anthropic.ts`, `openai.ts`, `google.ts`, `openai-compatible.ts`,
  presets, `wire-format.ts` (auth header construction + error translation)
- `telegram/src/bot.ts`, `config.ts`, `index.ts` (bot-token handling)
- `webui/src/server/index.ts` (WS auth token generation/compare/log)
- Repo-wide grep for live secret formats (Anthropic/OpenAI/GitHub/AWS/GCP/Slack/Telegram/PEM),
  `.env`/sample-config discovery, and `console.*`/`log.*` calls referencing
  apiKey/token/secret/headers/Bearer/config/body.
