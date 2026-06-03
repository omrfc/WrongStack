# Next Up

Carry-over work for the next session. Items are ordered by ROI
(impact-to-effort ratio, eyeballed). Each entry has a one-line "why"
and the smallest concrete next step so a future agent (or me
tomorrow) can pick it up without re-deriving context.

Last updated: 2026-06-03 (end of a 22-commit day, ~18h).

---

## 1. CLI / WebUI boot path unification — HIGH ✅ DONE (2026-06-03)

**Done.** Canonical `bootConfig(opts?: BootConfigOptions)` now lives in
`packages/core/src/infrastructure/boot.ts` (exported from the core barrel).
It does path resolution, the AES-GCM `DefaultSecretVault`, plaintext-secret
migration (label via `appLabel`: `wstack` vs `WebUI`), config + sync load,
project-meta write, and logger creation — the union of what cli/webui each
did. `packages/cli/src/boot-config.ts` and `packages/webui/src/server/boot.ts`
are now thin wrappers that re-shape the result into their legacy return types.
Behavior coverage moved to `packages/core/tests/infrastructure/boot.test.ts`;
the cli `boot-config.test.ts` (real core, temp HOME) and a slimmed webui
`boot.test.ts` (wrapper contract) round it out. 17 tests green; core/cli/webui
typecheck + build clean.

<details><summary>Original note</summary>

**Why.** `packages/cli/src/boot-config.ts` and
`packages/webui/src/server/boot.ts` are near-duplicates. Both:
- resolve wpaths via `DefaultPathResolver` + `resolveWstackPaths`
- create a real `DefaultSecretVault` (AES-GCM, not XOR)
- call `migratePlaintextSecrets` over `[globalConfig, projectLocalConfig]`
- print a `[wstack]/[WebUI] Encrypted N plaintext secret(s) in FILE`
  notice (now via `writeErr` after the Phase 5 cleanup)
- load config via `DefaultConfigLoader` + build a `DefaultLogger`

The drift already shows: cli has `ensureProjectMeta(wpaths, projectRoot)`;
webui has explicit `fs.mkdir(... recursive: true)` for the same three
paths. Either copy of that logic can fall behind when a new wpath is
added.

**Effort.** 2–3h. One repo, two consumers, one canonical core helper.

**Next step.** Add `bootConfig(flags?: Record<string, string|boolean>)`
to `packages/core/src/runtime/boot.ts` (or `infrastructure/boot.ts` —
pick whichever the architectural review has fewer cycles through) that
takes the `flags?` shape cli uses and returns `{ config, vault,
globalConfigPath, projectRoot, wpaths, logger }`. Both packages then
re-export it from their own `boot.ts` for backward compatibility. Keep
the per-package `bootConfig()` signature as a thin pass-through.

**Refs.** Audit report `04-architecture-refactoring.md` §5.5 (LOW
priority there, but the duplicated surface is the actual issue);
`packages/cli/src/boot-config.ts:36-58` and
`packages/webui/src/server/boot.ts:30-63` are the two near-duplicate
implementations.

</details>

---

## 2. webui/src/server/index.ts — remaining concerns

**Progress.** `index.ts` is now **1923 lines** (it had grown to 2046).
`http-server.ts` (#17), **`ws-auth.ts` (#6), `lifecycle.ts` (#18), and
`token-estimator.ts` (#7) are extracted**.

| # | Concern | Status | Migration cost |
|---|---------|--------|---------------:|
| 17 | `http-server.ts` — static serve, MIME, CSP, SPA fallback | ✅ done (`5200966`) | LOW |
| 6  | `ws-auth.ts` — token check, time-constant compare, DNS-rebinding | ✅ done (2026-06-03) | LOW |
| 18 | `lifecycle.ts` — graceful shutdown + SIGINT/SIGTERM | ✅ done (2026-06-03) | LOW |
| 7  | `token-estimator.ts` — per-section context.debug token breakdown | ✅ done (2026-06-03) | LOW |
| 11 | `error-formatter.ts` — ⚠️ plan mismatch (see below) | re-scope | LOW |
| 9  | `rest-routes.ts` — `/api/...` registration | ⚠️ does not exist | n/a |
| 8a | `provider-keys.ts` — `key.*`/`provider.*` record transforms | ✅ done (2026-06-03) | LOW |
| 8  | `ws-handlers.ts` — rest of the `handleMessage` switch | open | HIGH (shared state) |

**token-estimator.ts done (2026-06-03).** Extracted the `context.debug`
per-section token breakdown (~78 lines) into pure `estimateTokens` /
`stringifyContent` / `estimateContextBreakdown` in
`packages/webui/src/server/token-estimator.ts`; the WS handler now calls it and
layers `mode`/`policy` on top. New `token-estimator.test.ts` (7 tests, incl. the
per-block-type accounting + preview truncation). Note: faithful extraction —
the original (and the extract) assume `tool_use` blocks always carry an `input`
(`JSON.stringify(undefined)` would throw); real blocks always do. Full webui
suite 144 green; index.ts diff verified content-only (no biome reformat).

**#11 error-formatter — plan mismatch.** The sub-agent plan called this
"JSON-RPC error shape", but the webui server speaks a WebSocket broadcast
protocol (`{ type: 'error', payload }`), not JSON-RPC. The only real
duplication is `err instanceof Error ? err.message : String(err)` repeated
~10×. If actioned, it's a one-line `errMessage(err)` helper (+ maybe a
`sendError(ws, phase, err)` wrapper), NOT a ~40-line module. Re-scope or drop.

**lifecycle.ts done (2026-06-03).** Extracted the inline `shutdown` closure +
`process.on('SIGINT'/'SIGTERM')` into `packages/webui/src/server/lifecycle.ts`
(`createShutdown` + `registerShutdownHandlers`) with injectable `log`/`exit`
seams, so the teardown order, error-swallow, and idempotency are unit-testable
without killing the runner. `index.ts` passes a `flushSession` thunk + a
`clients()` getter (closes whoever is connected *at signal time*) + the server
list. Added a re-entrancy guard (rapid double Ctrl+C no longer runs teardown
twice) — minor behavior improvement. New `lifecycle.test.ts` (6 tests); full
webui suite 137 green; typecheck + build clean.

**ws-auth.ts done (2026-06-03).** Extracted the inline `verifyClient`/
`isLoopback`/`tokenMatches`/`hostHeaderOk` closures (~73 lines) into pure,
documented functions in `packages/webui/src/server/ws-auth.ts`; `index.ts`
keeps a thin adapter that pulls fields off the request and delegates (dropped
the now-unused `timingSafeEqual` import). Crucially, `ws-auth.test.ts` no longer
re-implements a simplified copy — it imports the **real** functions, and the
DNS-rebinding guard (`hostHeaderOk`) + constant-time `tokenMatches`, which had
**zero** real-code coverage, are now tested. 15 → **24 ws-auth tests**; full
webui suite 131 green; typecheck + build clean.

> Note: `ws-auth.test.ts` still carries local copies of `isPathSafe` and the
> rate limiter (separate concerns). `isPathSafe` is now redundant with
> `http-server.ts`'s exported `isInsideDist` — repoint it when #8's rate-limiter
> lands, or as a tiny standalone cleanup.

**provider-keys.ts done (2026-06-03).** Extracted the security-sensitive
provider/API-key record transforms (`normalizeKeys`, `writeKeysBack`,
`maskedKey`, and pure `upsertKey`/`deleteKey`/`setActiveKey`/`addProvider`/
`removeProvider`) out of the `key.*`/`provider.*` handlers into
`packages/webui/src/server/provider-keys.ts`. The handlers keep their
load/decrypt → transform → encrypt/save → WS-reply flow; only the in-memory
record mutation moved. This is the cleanly-separable, *pure* slice of #8 — the
rest of `handleMessage` mutates live `session`/`context`/`clients` and can't be
made pure this easily. New `provider-keys.test.ts` (19 tests) covers active-key
re-pointing, last-key-drops-provider, legacy single-key upgrade, masking. Full
webui suite 163 green; index.ts diff verified content-only. index.ts: 1923 →
1857.

**#9 rest-routes — does not exist.** The webui server has NO `/api/...` REST
routes; the HTTP server is static-file-only (`http-server.ts`) and all app
logic is WebSocket. Third sub-agent-plan item that didn't survive contact with
the code (after item 4 docs and #11 error-formatter). Dropped from the table.

**Next step.** The remaining #8 is the genuinely hard core: the ~35 stateful
`handleMessage` cases that mutate live `session`/`context`/`clients`/`config`
and broadcast. There's no integration test harness for the running server (all
webui tests are unit tests of extracted pure fns), so further extraction here
risks behavior changes that nothing would catch. Recommend pausing #8 until
either (a) a WS integration test harness exists, or (b) it's done with a
human-in-the-loop review. The #11 "error-formatter" is a tiny `errMessage()`
helper, not a module — do it opportunistically or drop.

**IMPORTANT (process).** Do NOT `biome --write` `index.ts` (or other
pre-existing committed files) — they aren't biome-clean at HEAD and `--write`
reformats the whole file into a multi-thousand-line noise diff. Use targeted
edits; `--write` only files you create whole. Verify with
`git diff --shortstat` vs `--ignore-all-space` (should match).

**Refs.** Commits `5200966` (http-server) and the ws-auth / lifecycle /
token-estimator extractions above show the exact pattern.

---

## 3. Phase 6: input-reader readLine + readSecret tests — ✅ DONE (2026-06-03)

**Done.** Added `packages/cli/tests/input-reader-line-secret.test.ts` (9
tests): `readLine` via a `node:readline` mock (entered line, default `> `
prompt, Ctrl+C/EOF close → empty, history persistence) and `readSecret` via a
fake TTY stdin + `process.stdout.write` spy (bullet masking, DEL backspace,
Ctrl+U clear-line, raw-mode restore + stdin pause, non-TTY → readLine
fallback). Every reader uses a throwaway temp `historyFile` so tests never
touch the real `~/.wrongstack/history`. Original readKey test header updated to
point at the new file. 13 input-reader tests green; cli typecheck clean.

<details><summary>Original note</summary>

**Why.** `packages/cli/tests/input-reader.test.ts` (commit `3fe3bc8`)
covers `readKey` (4 tests). The other two methods on the same
reader are uncovered:

- `readLine` uses `readline.createInterface` and prompts a free-form
  string. Mocking requires faking the interface and a writable tty.
- `readSecret` toggles raw mode, accumulates bytes, prints bullets,
  and restores mode on Enter / Ctrl+C. The mask-then-restore dance
  is the exact kind of thing a future refactor will quietly break.

**Effort.** 1–1.5h (mostly the `readSecret` mask harness).

**Next step.** For `readLine`: stand in for stdin with the same fake
`EventEmitter`-based stream used by the readKey test, then resolve
`rl.question` directly (export a `createReadline` shim so the test
can supply its own readline). For `readSecret`: assert on
`process.stdout.write` capture (the bullets are routed through
`writeOut` after Phase 4) and verify the post-Enter raw-mode restore.

**Refs.** `packages/cli/src/input-reader.ts:140-180` (readSecret
implementation), the existing readKey test for the fake-stdin pattern.

</details>

---

## 4. `process.stdout.write(` in docs — ⚠️ PREMISE INVALID, recommend close

**Reassessed 2026-06-03.** Inspected all three sites; none is a
WrongStack output site that should adopt `writeOut`, so the original
"trains contributors to copy the old pattern" rationale doesn't hold:

- `packages/mcp/README.md:178,184` — inside a **"Writing Your Own MCP
  Server"** standalone stdio example. Those writes ARE the JSON-RPC
  protocol channel; they must stay `process.stdout.write` (+`flush`).
  The example server doesn't import `@wrongstack/core` and shouldn't.
  Changing these would be actively wrong.
- `packages/core/skills/node-modern/SKILL.md:144` — a generic
  **"Web Streams"** teaching snippet (read a `fetch` body, print the
  decoded chunk). It teaches Node stream mechanics, not WrongStack
  output conventions; a `writeOut` import would muddy a generic lesson.
- `packages/providers/README.md:52` — a `provider.stream()` usage
  example printing text deltas. Borderline, but it documents using
  `@wrongstack/providers` standalone; `writeOut` (a core export) isn't
  necessarily in scope for a providers consumer, and `process.stdout.write`
  is the idiomatic "print streamed tokens" form.

**Recommendation.** Close this item. If we still want the teaching
win, the right move is a one-line note in the *contributing* docs that
`writeOut` is the seam for first-party CLI output — not edits to these
three third-party/standalone examples.

---

## 5. Re-run the audit-log triage sub-agent

**Why.** The last audit delegation timed out at 10 minutes. The
manual grep for the M1/M2/M3 batch (`02-bug-hunt-tools-cli.md`)
showed all three were already fixed in the current code, but that
was a quick scan — there are still 4 reports
(`03-security-audit.md`, `04-architecture-refactoring.md`,
`05-dependency-package-health.md`, `08-extensibility-configurability-audit.md`)
that may have open MEDIUM items I didn't fully triage.

**Effort.** 1h (sub-agent dispatch + review).

**Next step.** Re-dispatch the audit-log role with the same task
description as before, but give it 25 minutes (`timeoutMs: 1_500_000`)
and `maxIterations: 80` instead of the default 10-minute / 30-iter
budget. The previous attempt spent 13 iterations reading 8 files in
parallel and was about to start writing the report when it hit the
timeout. Read its findings, file the open MEDs into a follow-up
section of this `next.md`, and pick at most 2 to action this week
(rest are deferred to a planned hardening sprint).

**Refs.** `.reports/02-bug-hunt-tools-cli.md` lines 100-150 for the
M-series format that's now clean (good template for the new
findings).

---

## 6. bun.lock format diff

**Why.** Mentioned earlier in the day but not acted on — likely a
benign CRLF / ordering difference from whoever last ran `bun install`
in CI. Worth a one-line fix to keep the diff surface small.

**Effort.** 5 minutes (or zero, if it's just a regenerate).

**Next step.** Run `bun install` and commit the resulting
`bun.lock` if it changed. If the diff is the same after a
regenerate, it was a toolchain artifact — close the item.

---

## Deferred (out of scope for next session)

- Decompose `cli/src/index.ts` further — 130 lines already came out
  in commit `5d2595e`, but 1,310 lines still remain. The next
  biggest extraction candidates are the slash-command registration
  loops and the JSONL-result emit. Both are MEDIUM-risk; budget a
  half-day when there's a clear consumer for the extracted function.
- MEDIUM-severity findings in `.reports/03-security-audit.md:109`
  and `.reports/04-architecture-refactoring.md:157` — pull these
  once the audit-log sub-agent (item 5) finishes its re-triage.
- Replace `process.env['PORT']` reads with a typed `env` helper —
  sprinkled through 8+ files, no risk, ~1h, but only worth doing
  alongside item 1 (boot unification reuses the same env-reading
  pattern).
