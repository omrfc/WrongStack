# SDD parallel run — remaining work (`sdd-next.md`)

> Follow-up backlog for the "a `/sdd parallel` run must never get stuck, never explode, never
> silently go bad" initiative. The **engine** for all four mechanisms (completion gate, mergeable
> worktrees, supervisor, task split) plus the **CLI** production wiring is shipped and tested.
> This document tracks what is intentionally deferred or only partially wired, with enough detail
> to pick up cold.

Last updated: 2026-06-25. All paths are relative to the repo root.

---

## 0. What already shipped (context)

Engine + control plane, all in `packages/core/src/sdd/`, fully unit-tested (405 SDD/related tests
green; `core`/`webui`/`cli` typecheck clean):

| Area | Mechanism | Key symbols |
|---|---|---|
| Budget | Idle reaper instead of hard 5-min wall-clock cap; default `parallelSlots` 2; `maxRetries` 3 | `SddParallelRun` ctor, `idleTimeoutMs`/`taskTimeoutMs` |
| Retry | Bounded end-of-run failed-task sweep + manual "retry all failed" | `requeueFailedTasks`, `retryAllFailed`, `maxFailedRetrySweeps` |
| **A** Completion gate | A worker "success" is gated by verification **before** complete & **before** merge | `SddParallelRunOptions.verifyTask`, `executeOne` |
| **C** Mergeable worktrees | Completion gated on a clean squash-merge; unresolved conflict → retry-on-fresh-base → fail (never silently "completed") | `integrateWorktree`, `conflictResolver`, fixed `resolveWorktrees` data bug |
| **D** Supervisor | On retry-exhaustion, a `BrainArbiter` decides retry/reassign/split/fail (bounded by `maxSupervisorEscalations`) | `superviseFailure`, `SddSupervisor` (`sdd-supervisor.ts`) |
| **B** Split | `splitTask` rewires deps (leaves inherit parent blockers; dependents wait on all leaves; parent → completed container) | `splitTask`, `SddSubtaskSpec` |

New `EventBus` events (`packages/core/src/kernel/events.ts`): `sdd.task.verification_failed`,
`sdd.task.conflict`, `sdd.task.split`, `sdd.supervisor.decision`.

New control commands drained by `start-sdd-run.ts`: `retry_all_failed`, `split_task` (plus the WS
types `sdd.board.retry_all_failed`, `sdd.board.split_task` and the shared `CONTROL_TYPES` set in
`packages/webui/src/server/sdd-board-ws-handler.ts`).

CLI production wiring (`packages/cli/src/cli-main.ts`, in the `/sdd parallel` handler): a real
`verifyTask` (spawns `metadata.verificationCommand` in the task cwd, 180 s timeout) and
`new core.SddSupervisor({ brain })` are passed into `startSddRun`.

---

## P1 — Correctness / parity (do first) — ✅ DONE (2026-06-25)

All three P1 items are shipped and tested (339 SDD core tests green; core/webui/cli/tui typecheck
clean). Summary:
- **P1.1** `verifyTask` extracted to `packages/core/src/sdd/verify-task.ts` (`makeCommandVerifier`),
  exported via the sdd + defaults barrels. Both `cli-main.ts` and the standalone wizard
  (`sdd-wizard-wiring.ts`) now use it; the standalone wizard also constructs `SddSupervisor` from
  the server-bound `brain` threaded through `buildSddWizardDeps({ brain })`. The CLI-hosted webui
  server does **not** host the wizard (confirmed — no `buildSddWizardDeps` import in `cli/src`), so
  no wiring needed there.
- **P1.2** `SddBoardProjector` now subscribes to all four robustness events and pushes feed entries
  (`board-types.ts` `kind` union extended with `verification_failed`/`conflict`/`split`/
  `supervisor`). Rendered in the WebUI feed (`SDD_FEED_KIND` icons in `sdd-theme.ts`; the webui
  `SddBoardFeedEntry` kind union widened) and a new "Recent activity" footer in the TUI overlay
  (`sdd-board-overlay.tsx`).
- **P1.3** Tests added: `verify-task.test.ts` (exit 0 / non-0 / timeout / custom key), a
  `start-sdd-run` gate-integration test (failing `verifyTask` keeps a task out of `completed`), and
  a projector test asserting the four events narrate into the feed.

<details><summary>Original P1 detail (for reference)</summary>

### P1.1 Standalone WebUI runs get NO gate and NO supervisor
**Problem.** `packages/webui/src/server/sdd-wizard-wiring.ts` (`startRun`, ~line 98) calls
`startSddRun({...})` **without** `verifyTask` or `superviseFailure`. Runs launched from the
standalone WebUI wizard therefore skip the completion gate and the failure supervisor entirely —
a behavioural divergence from the CLI (`cli-main.ts`).

**Approach.**
- This process must build its own `verifyTask` (same spawn-`metadata.verificationCommand` helper
  as `cli-main.ts`) and `SddSupervisor`. Factor the CLI's `verifyTask` closure into a shared core
  helper so both surfaces use one implementation, e.g. `makeCommandVerifier()` in a new
  `packages/core/src/sdd/verify-task.ts` (core may use `node:child_process` — it already does for
  git detection). Then both `cli-main.ts` and `sdd-wizard-wiring.ts` import it.
- The standalone server needs a `BrainArbiter` to construct `SddSupervisor`. Check whether the
  standalone server already binds `TOKENS.BrainArbiter` (search `packages/webui/src/server/`); if
  not, bind a `DefaultBrainArbiter` (safe policy — bounded retry) or thread the session brain in.
- The CLI-hosted WebUI server (`packages/cli/src/webui-server.ts`) runs in the CLI process, so it
  already benefits from the CLI wiring **only if** runs are launched via the CLI `/sdd parallel`
  path. Confirm whether the CLI-hosted webui can launch its own runs (wizard) and, if so, wire it
  too.

**Files.** `sdd-wizard-wiring.ts`, new `packages/core/src/sdd/verify-task.ts`, `cli-main.ts`
(refactor to use the shared helper), maybe `packages/webui/src/server/index.ts` (brain binding).

**Verify.** Start a run from the standalone WebUI with a task carrying a failing
`verificationCommand`; confirm it does not turn green and is retried/failed. Add a server test
mirroring `packages/core/tests/sdd/start-sdd-run.test.ts`.

### P1.2 Surface the new events on the live board
**Problem.** `sdd.task.verification_failed`, `sdd.task.conflict`, `sdd.task.split`, and
`sdd.supervisor.decision` are emitted but may not be reflected in the board snapshot/feed. Verify
`packages/core/src/sdd/sdd-board-projector.ts` forwards them (it subscribes to `sdd.*`); if it
only handles a fixed set, add these so the WebUI feed + TUI overlay show "verification failed",
"merge conflict", "split into N", and supervisor decisions.

**Approach.** Inspect `SddBoardProjector`'s event subscriptions and `board-types.ts`
`SddBoardFeedEntry` shape. Add feed entries (and, if useful, a per-task badge such as a
`conflictFiles` marker) for the four events. Then render them in
`packages/webui/src/components/SddActivityFeed.tsx` and the TUI overlay
(`packages/tui/src/components/sdd-board-overlay.tsx`).

**Verify.** Trigger each event in a run and confirm it appears in the WebUI feed and TUI overlay.

### P1.3 Tests for the CLI/standalone production wiring
**Problem.** The `cli-main.ts` `verifyTask`/`SddSupervisor` wiring has no test (the engine is
tested, the glue is not).

**Approach.** Extract `verifyTask` (P1.1) so it is unit-testable: a temp dir + a command that
exits 0 / non-0 / hangs (timeout). Add a `start-sdd-run` integration test that passes a real
`verifyTask` and asserts a failing command keeps the task out of `completed`.

</details>

---

## P2 — Make the supervisor actually intelligent — ✅ DONE (2026-06-25)

All three P2 items are shipped and tested (348 SDD core tests green; core/webui/cli typecheck
clean). Summary:
- **P2.1** `reassignModels` wired: CLI passes `core.effectiveFallbackChain(config)`; the standalone
  passes the wizard's run-level `fallbackModels`. The supervisor's `reassign` branch now parses
  `provider/model` refs (`parseModelRef`) so a chain entry sets both fields on the verdict.
- **P2.2** `makeLlmSubtaskGenerator` added (`packages/core/src/sdd/decompose-task.ts`): one isolated
  read-only LLM turn → validated, bounded `SddSubtaskSpec[]` (≥`min`, ≤`max`, enum-checked; junk /
  too-few → `[]` → supervisor retries). Wired into the standalone via a shared `runIsolatedTurn`
  helper (factored out of `runInterviewTurn`). Exported from the sdd + defaults barrels.
- **P2.3 (decided explicitly)** New `SddSupervisorOptions.requestLlmVerdict` flag. Default **false**
  → `fallback: 'continue'` (policy answers in place; safe bounded retry; LLM never runs). When
  **true** → `fallback: 'ask_human'` so the tiered brain's LLM layer actually picks reassign/split;
  an unresolved escalation degrades to a **bounded retry** (never a dead-end), a hard `deny` →
  fail. Enabled in the **standalone** (its tiered brain has no `HumanEscalatingBrainArbiter`
  wrapper, so it can't block); left **off in the CLI** (its brain *is* human-escalating and would
  block mid-run). Both call sites are commented with the rationale.

<details><summary>Original P2 detail (for reference)</summary>

Today the CLI builds `new SddSupervisor({ brain })` with **no** `reassignModels` and **no**
`generateSubtasks`, so the only options offered to the brain are retry/fail, and under the
`DefaultBrainArbiter` policy (`fallback: 'continue'`) the verdict is always a bounded retry. That
is safe but under-delivers the "reassign / split into multiple sub-models" intent.

### P2.1 Wire `reassignModels`
**Approach.** In `cli-main.ts` (and the standalone wiring) pass the run-level fallback chain as
`reassignModels`, e.g. derive from the resolved config fallback models (the same list used for
`createFallbackModelExtension`). Then a `reassign` verdict rotates the worker model on retry
(`SddParallelRun.setTaskModel` + requeue is already implemented in `trySupervisorRescue`).

**Files.** `cli-main.ts`, `sdd-wizard-wiring.ts`, `SddSupervisorOptions`.

**Risk.** Reassign only helps if the alternate model is actually configured/authorised; validate
the model id resolves before offering it.

### P2.2 Wire `generateSubtasks` (LLM auto-split)
**Approach.** Provide `SddSupervisorOptions.generateSubtasks` backed by an LLM decomposition of
the failing task. Reuse the existing decomposition path — `packages/core/src/sdd/task-generator.ts`
(`TaskGenerator`) already turns spec/acceptance-criteria into tasks; add a focused
`decomposeTask(task, error): Promise<SddSubtaskSpec[]>` that prompts the leader model to break one
failing task into 2–4 smaller sub-tasks and parses the result (mirror `SddTaskDecomposer`/
`TaskGenerator` JSON-parsing + validation). The supervisor already degrades an empty result to a
retry.

**Risk.** Unbounded recursive splitting — guard with the existing `maxSupervisorEscalations` and a
minimum-size check so a leaf can't be split into itself. Also ensure generated sub-tasks inherit a
sensible `type`/`priority` (defaults already fall back to the parent's).

**Verify.** Unit test with a fake generator returning N subtasks → `splitTask` runs and the parent
becomes a completed container (already covered by the engine test; add a CLI-level test).

### P2.3 Decide the brain risk/fallback for real LLM verdicts
**Note.** `SddSupervisor` uses `risk: medium|high`, `fallback: 'continue'`. With the tiered brain,
a policy `answer` short-circuits before the LLM layer, so the LLM never actually decides. If
LLM-driven decisions are wanted, the supervisor must request with `fallback: 'ask_human'` so the
tiered arbiter escalates to the autonomous (LLM) layer — **but** that risks blocking on
`HumanEscalatingBrainArbiter` in a headless run. Resolve by: (a) only using `ask_human` when an
autonomous layer is present and the autonomy ceiling allows it, or (b) adding a timeout/`continue`
default. Decide explicitly before flipping the fallback. See
`packages/core/src/execution/autonomy-brain.ts` (`createTieredBrainArbiter`).

</details>

---

## P3 — Completion-gate ergonomics (give the gate teeth, safely)

> **P3.1 ✅ DONE (2026-06-25).** `set_task_verification` control plumbed end-to-end
> (`SddParallelRun.setTaskVerification` → registry → `start-sdd-run` drain → `CONTROL_TYPES` →
> `webui/types.ts` → `SddTaskDrawer` editor, keyed per task). Board task surfaces
> `verificationCommand`. Tested (engine unit + drain integration). **P3.2 ✅ DONE (2026-06-25):**
> `TaskGenerator.verificationFromAcceptance` (off by default) derives a task's `verificationCommand`
> from an acceptance criterion carrying a runnable marker (`$ <cmd>` / `run:` / `verify:` / `cmd:`)
> via the exported `extractVerificationCommand`; both core construction sites gate it behind
> `WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE=1`, so the fast common case is unchanged.

The gate is **opt-in**: it only runs when a task has `metadata.verificationCommand`. Nothing sets
that yet (deliberately — auto-running tests per task would reintroduce the slowness/stuck problem
the initiative set out to fix). To make A useful without that regression:

### P3.1 Let users set a per-task verification command from the board
**Approach.** Mirror the existing `set_task_model` plumbing: a new control `set_task_verification`
+ WS type `sdd.board.set_task_verification` (add to `CONTROL_TYPES`, `webui/src/types.ts`,
`start-sdd-run.ts` drain), a `SddParallelRun.setTaskVerification(id, cmd)` that `patchMetadata`s
`verificationCommand`, a `SddRunControl.setTaskVerification`, and a small input in
`SddTaskDrawer.tsx` (next to the model picker). Then a user can attach `pnpm vitest run <file>` to
a specific task.

**Files.** `sdd-parallel-run.ts`, `sdd-run-registry.ts`, `start-sdd-run.ts`,
`sdd-board-ws-handler.ts`, `webui/src/types.ts`, `SddTaskDrawer.tsx`, `SddBoardView.tsx`.

### P3.2 Optional spec-driven default
**Approach.** If a `SpecRequirement` carries acceptance criteria that map to a runnable check, let
`TaskGenerator` populate `metadata.verificationCommand` for tasks that link to that requirement —
**off by default**, behind a spec/CLI flag, so the common case stays fast.

---

## P4 — Conflict-resolution intelligence (C is currently "retry on fresh base, else fail")

> **✅ DONE (2026-06-25) — heuristic tier.** `makePreferSideConflictResolver('incoming'|'base')`
> added (`packages/core/src/sdd/conflict-resolver.ts`); the CLI wires it behind
> `WRONGSTACK_SDD_CONFLICT_RESOLVER` (default unset → conservative retry-then-fail, unchanged). The
> WorktreeManager still rejects any rewrite that leaves markers, so a bad resolution degrades
> safely. **Verify-after-merge now CLOSED (2026-06-25):** a merge that only landed because the
> resolver rewrote files (`MergeResult.resolved`) is re-verified against the integrated base; on
> regression the squash commit is reverted (`WorktreeManager.baseHead` captured pre-merge +
> `revertBaseTo`) and the task fails (retry on fresh base) — an auto-resolution can never silently
> stick a broken base. **Deferred:** an LLM-backed resolver (the heuristic is the only tier).

`integrateWorktree` accepts a `conflictResolver` but the CLI/standalone wiring injects none, so an
unresolved conflict always degrades to a fresh-base retry then terminal-fail. That is correct and
never wedges, but a resolver could salvage more.

**Approach.** Provide `SddParallelRunOptions.conflictResolver` from the CLI: an LLM/heuristic that,
given `{ task, conflictFiles, cwd }`, edits the conflicted files in the base checkout and returns
`true` once markers are gone (the manager validates marker-freeness — see
`packages/core/src/worktree/worktree-manager.ts` `tryResolveConflict`/`hasConflictMarkers`). Start
with a trivial heuristic (e.g. prefer-incoming for generated files) before an LLM resolver.

**Risk.** A bad auto-resolution silently corrupts the base. Keep the conservative default; gate any
LLM resolver behind explicit opt-in and always re-run the verification gate after a resolved merge.

---

## P5 — TUI parity

> **✅ DONE (2026-06-25) — option (a).** `/sdd split <id> <A ; B>` slash command added (parses
> `;`-separated `Title :: description` sub-tasks) → `onSddSplitTask` → `SddRunRegistry.getActive()
> .splitTask` with board short-id resolution. Help + docs updated; `retry-failed`/`retry-all` were
> already present. The new feed events render in the TUI overlay's "Recent activity" footer (P1.2).

The TUI Ctrl+B board overlay (`packages/tui/src/components/sdd-board-overlay.tsx`) is read-only.
The `/sdd retry-failed` slash command exists, but there is no TUI affordance for **split** or
per-task retry/cancel, and the new events aren't shown.

**Approach.** Either (a) add a `/sdd split <task> <subtask;subtask>` slash command wired to
`SddRunRegistry.getActive()?.splitTask(...)` (cheapest, matches the read-only overlay design), or
(b) add key bindings to the overlay (requires routing input + registry access — see the
`handleKey hosted in Input` constraint in project memory). Prefer (a). Also render the new feed
events from P1.2.

---

## P6 — Docs & housekeeping

> **✅ DONE (2026-06-25).** `docs/slash/sdd.md` updated (retry-failed, split, the robustness
> section + `verificationCommand` contract). Work committed to branch
> `feat/sdd-parallel-robustness` in reviewable slices (engine → CLI → WebUI → tracker). The
> dangling `./packages/tui2` tsconfig reference was removed. Note: a concurrent editor's unrelated
> `packages/tui/src/components/history*` changes were left uncommitted in the working tree.

- **Docs.** Update `docs/slash/sdd.md` for `/sdd retry-failed` (+ `retry-all` alias) and any new
  `/sdd split`. Document the `metadata.verificationCommand` contract and the split semantics in
  `AGENTS.md` / SDD docs. Document the four new EventBus events (per repo convention, events get a
  doc comment in `events.ts` — already added; cross-reference in `AGENTS.md`).
- **Commit.** This work currently sits **uncommitted on `main`**. Move it to a feature branch and
  commit in reviewable slices (engine → CLI wiring → WebUI surface). Note the lockstep-version and
  `--no-verify` constraints in project memory for any release commit.
- **`tsconfig.json`.** A dangling `./packages/tui2` project reference (committed by a concurrent
  editor; the package is absent) was removed to unblock the vitest oxc tsconfig resolver. If
  `packages/tui2` returns, re-add the reference.

---

## Wiring map (where each seam lives)

```
SddParallelRunOptions            packages/core/src/sdd/sdd-parallel-run.ts
  ├─ verifyTask                  → executeOne (gate before complete + merge)
  ├─ conflictResolver            → integrateWorktree (merge gate)
  ├─ superviseFailure            → applyTaskFailure → trySupervisorRescue
  ├─ maxFailedRetrySweeps        → run() settle branch (requeueFailedTasks)
  └─ maxSupervisorEscalations    → per-task rescue loop guard
SddSupervisor                    packages/core/src/sdd/sdd-supervisor.ts  (brain → verdict)
startSddRun passthrough          packages/core/src/sdd/start-sdd-run.ts   (+ control drain)
SddRunControl                    packages/core/src/sdd/sdd-run-registry.ts
Events                           packages/core/src/kernel/events.ts        (sdd.task.*, sdd.supervisor.*)
WebUI control gate               packages/webui/src/server/sdd-board-ws-handler.ts (CONTROL_TYPES)
WebUI WS types                   packages/webui/src/types.ts
WebUI board UI                   packages/webui/src/components/SddBoardView.tsx, SddTaskDrawer.tsx
CLI production wiring            packages/cli/src/cli-main.ts (/sdd parallel handler)
Standalone WebUI wiring          packages/webui/src/server/sdd-wizard-wiring.ts  ← P1.1 gap
```

## Verification commands

```bash
pnpm vitest run packages/core/tests/sdd/                 # engine + supervisor (332+)
pnpm vitest run packages/cli/tests/slash-sdd.test.ts     # /sdd slash incl. retry-failed
cd packages/webui && pnpm exec vitest run tests/components/sdd-controls.test.tsx  # drawer (split form)
pnpm --filter @wrongstack/core typecheck
pnpm --filter @wrongstack/core build                     # rebuild dist before the cli typecheck
pnpm --filter @wrongstack/cli typecheck
pnpm --filter @wrongstack/webui typecheck
```

> Note: `@wrongstack/cli` typechecks against `@wrongstack/core`'s built `dist/*.d.ts`, so rebuild
> core after changing core's public surface before typechecking the CLI.
