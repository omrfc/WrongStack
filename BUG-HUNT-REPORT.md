# WrongStack — Bug Hunt & Refactor Plan

> Multi-agent sweep, 2026-06-18. 14 finder lenses → adversarial verification (each finding re-read against real code by an independent skeptic). **71 candidates → 61 confirmed, 10 refuted.** Deduped to **~48 distinct issues** below (some bugs were found by 2 lenses). Focus areas as requested: autonomous coordinator, WebUI (both servers), core/kernel & tools — all equal weight.

Severity is the verifier-adjusted severity. `file:line {lens}` points at the proof.

---

## 🔴 CRITICAL (1 distinct)

### C1. Standalone WebUI server rejects **every** WebSocket message
`packages/webui/src/server/index.ts:1333-1347` {webui-server, typesafety — found twice}
The prototype-pollution guard uses the `in` operator (`'__proto__' in obj || 'constructor' in obj || 'prototype' in obj`). `in` walks the prototype chain, so **every** object from `JSON.parse` matches (`'constructor' in {}` is always `true`). The guard's error branch fires for every legitimate message → the standalone `wrongstack webui` server replies `Invalid message object` to everything and is effectively non-functional.
**Fix:** use `Object.hasOwn(obj, '__proto__') || Object.hasOwn(obj, 'constructor') || Object.hasOwn(obj, 'prototype')` (own-property check, no chain walk).

---

## 🟠 HIGH (8 distinct)

### H1. Autonomous coordinator `run()` never populates the DAG → core spawn loop is a permanent no-op
`packages/core/src/coordination/autonomous-coordinator.ts:479-523` {coord-correctness}
`run()` → `_decomposeGoal` → `auction.publishTask` (writes GoalNodes to the KnowledgeGraph only). Nothing in this path calls `this.dag.addNode` (only `createGoal`, which `run()` never uses). `_processGoal` gates all work on `this.dag.getReady()`; the DAG is empty → returns `[]` → `_processGoal` returns immediately every iteration. **No subagent is ever spawned via the director path.**
**Fix:** populate the DAG from decomposed goals before the loop, or make `_processGoal` operate on the auction/graph instead of the DAG.

### H2. `runUntilComplete` exits on iteration 1 + deadlock detection never fires (same empty-DAG root cause)
`autonomous-coordinator.ts:266, 287-291` {coord-correctness}
Empty DAG → `isDone()` is `[].every(...) === true`. With `runUntilComplete` the loop breaks on iteration 1 while every goal is still pending. `getBlocked()`/`hasDeadlock()` also operate on the empty DAG, so `deadlock:detected` can never fire for goals from the normal path (active in production whenever `brain.decideAuto` returns `deny`).
**Fix:** drive completion/deadlock off auction/graph statuses (or populate the DAG — fixes H1 too).

### H3. `_handlePendingChange` votes as an unregistered voter → throws → tears down the whole run loop
`autonomous-coordinator.ts:525-546` {coord-correctness}
`_buildVoters()` registers critic/bug-hunter/security-scanner/audit-log/refactor-planner — never `selfAgentId`. `_handlePendingChange` calls `consensus.castVote(change.id, this.selfAgentId, …)`; `castVote` throws `unknown voter`. The call is awaited bare inside the while-loop (only try/finally just resets `running`), so the first pending change crashes `run()` with an unhandled rejection.
**Fix:** register `selfAgentId` as a voter (or use an eligible id) **and** wrap `_handlePendingChange` in try/catch.

### H4. Budget multi-kind threshold: O(N²) events + first-wins resolve silently drops other limits' extensions
`packages/core/src/coordination/subagent-budget.ts:386-396, 432-466` {coord-budget — two findings}
When one `checkLimits()` pass finds N exceeded kinds (e.g. iterations **and** tokens), the loop starts one `_negotiateExtension` per kind (the `.has()` dedup only spans separate calls), and `requestDecision` emits one event per kind. So N negotiations × N events = O(N²). Worse: all events share one `resolved` flag — the **first** listener's `extend()`/`deny()` resolves the promise; every other kind's `extend()` becomes a no-op, so the second exceeded limit is **never actually raised**.
**Fix:** one negotiation per pass; aggregate all kinds' `extend()` payloads into a merged patch and resolve once.

### H5. Standalone WebUI broadcasts `tool.progress` in a shape the client can't read → live tool output never renders
`packages/webui/src/server/setup-events.ts:89-103` {webui-ws-parity}
Standalone emits flat `{ id, name, eventType, text }`; the `WSToolProgress` type and the client handler expect nested `{ id, name, event: { type, text } }`. Client reads `payload.event?.text` → `undefined` → early-returns on `if (!text)`. Streaming bash output / partial_output / warnings never appear under `wrongstack webui`.
**Fix:** broadcast `payload: { id, name, event: { type, text, data } }` (match the CLI server).

### H6. OfficeMap "Animate wires" toggle does nothing
`packages/webui/src/components/OfficeMapCanvas.tsx:544-633, 706` {webui-client-react}
Edge renderer reads `useOfficeMapStore.getState().animateEdges` (one-shot snapshot, not a subscription) → edges don't re-render on toggle. The canvas *does* subscribe to `animateEdges` but never uses it.
**Fix:** subscribe inside the edge component, or thread `animateEdges` into each edge's `data.animated` and add it to the rebuild effect deps.

### H7. Plan/task store swallows write failures → tool reports `ok:true` on a failed persist
`packages/core/src/storage/plan-store.ts:89-115` {tools-plan-task}
`savePlan` catches all write errors, `console.warn`s, returns void. `mutatePlan` returns the in-memory plan regardless; `planTool` then returns `{ok:true}` even when `atomicWrite` failed (disk full, EACCES, win32 rename EPERM). The "survives resume" contract is silently violated. `saveTasks` has the same shape.
**Fix:** re-throw (or return a boolean) and propagate so the tool returns `ok:false` with the real error.

### H8. F5 Plan panel reads the wrong directory → always shows an empty plan
`packages/tui/src/components/plan-panel.tsx:46-56` + `packages/tui/src/app.tsx:5949-5955` {cli-tui-wiring — two findings}
PlanPanel recomputes the plan path from the repo working tree (`<projectRoot>/.wrongstack/sessions/…`), but the `/plan` tool writes to the global per-project dir (`~/.wrongstack/projects/<slug>/sessions/…`). The two never coincide → panel always reads a missing file. Compounded: the panel is mounted with `sessionId={null}` hardcoded, so even "session" scope falls through to the project `backlog.plan.json` and the in-panel scope toggle is non-functional.
**Fix:** thread the seeded `plan.path` (and live `session.id`) into PlanPanel instead of recomputing.

---

## 🟡 MEDIUM (16 distinct)

**Coordination**
- **M1.** Director-spawned subagent id never recorded as the goal's assignee → `_onSubagentTerminated` finds no tasks → completion/failure never recorded. `autonomous-coordinator.ts:506-519,563-586` {coord-correctness}
- **M2.** `GoalNode.blockedBy` is always written `[]` and never updated → dependent-unblock guard is vacuously true (children unblock prematurely); "blocked" filters are dead. `task-auctioneer.ts:157,331-349,426,455` {coord-correctness}
- **M3.** `attachAutoExtend` extends `timeoutMs` for an `idle_timeout` overrun instead of `idleTimeoutMs` → idle stall re-trips immediately; "granted" extension is meaningless. `auto-extend.ts:54-61,101-114` {coord-budget — two findings}
- **M4.** `TaskAuctioneer` has no `dispose()` → FleetBus subscriptions and open bid-window `setTimeout`s leak on coordinator stop/restart. `task-auctioneer.ts:115-128` {coord-resource}

**WebUI server**
- **M5.** `git.info` ahead/behind **swapped** in the standalone server (`--left-right --count` prints behind\tahead; standalone reads `[ahead,behind]`). CLI server is correct. `index.ts:3048-3070` {webui-ws-parity}
- **M6.** `git.info` deletions always `0` — regex `/\+\s*(\d+)\s*deletion/i` requires a `+` that never precedes `deletions(-)`. `index.ts:3058-3062` {webui-server, webui-ws-parity}
- **M7.** `webui.shutdown` (`/exit`) handled by CLI server but **not** the standalone server, and absent from the `WSClientMessage` union (only compiles via `as never`). `ChatInput.tsx:108-111` {webui-ws-parity}
- **M8.** Status-watcher teardown is hooked to a **non-existent** `process.on('cleanup')` event → FSWatcher, 60 s metrics `setInterval`, and debounce timers all leak forever. `setup-events.ts:490-518` {webui-server}
- **M9.** Rate-limit map keyed by the shared `session.id` (all browsers get the same id) → one tab rate-limits another; close handler deletes `String(ws)` (never a real key) → entries leak. `index.ts:1252-1266,1358-1360` {webui-server}

**WebUI client**
- **M10.** OfficeMap live status patches clobbered by full node rebuild on every mailbox/fleet change + uncleaned `fitView` timer. `OfficeMapCanvas.tsx:716-933` {webui-client-react}
- **M11.** ActivityBar Fleet/Agents icon active-state read via `getState()` at render → highlight goes stale (no re-render on `inspectorOpen`/`inspectorTab`). `ActivityBar.tsx:206-223` {webui-client-react}
- **M12.** `coordinator-monitor-store` `tasks`/`subagents`/`consensusVotes` Maps grow unbounded (only `events`/`budgetAlerts` are capped). `coordinator-monitor-store.ts:228-375` {webui-client-react}

**Core / tools / CLI**
- **M13.** Stray `import { toErrorMessage } …` line sits **inside** the `ENHANCER_SYSTEM_PROMPT` template literal → shipped verbatim to the provider, polluting the refiner prompt. `prompt-enhancer.ts:21-22` {webui-browser-safety} *(matches the known "concurrent toErrorMessage refactor corruption" pattern)*
- **M14.** `taskify`/`planify` ignore `scope:'project'` for the cross-file write → task written to the **session** file though project scope was requested; mirror bug in `task.ts planify`. Also taskify writes the task file **without its lock** (race vs parallel batch calls). `plan.ts:314-332` {tools-plan-task — two findings}
- **M15.** CLI `client.status` cost is always `0` — reads `e.usage.cost`, which doesn't exist on `Usage` (also a type error). `cli-main.ts:472-480` {cli-tui-wiring}
- **M16.** `/tasks add` truncates multi-word titles to the first word (`add Fix the auth bug` → title `Fix`). `slash-commands/tasks.ts:147-160` {cli-tui-wiring}

---

## 🟢 LOW (15 distinct)

- **L1.** `task-dag._wouldCycle` traverses `dependents` (outgoing) instead of `deps` (incoming) → never detects a real back-edge (masked today by idempotent addNode). `task-dag.ts:403-416`
- **L2.** Bid award doesn't re-check winner capacity → agent can exceed `maxTasksPerAgent`. `task-auctioneer.ts:557-585`
- **L3.** `lastSeenKey` dedup is a single scalar, never reset → a legitimately re-tripped `(kind,limit)` is swallowed with neither `extend()` nor `deny()` → negotiation hangs until the 60 s fallback → `stop`. `auto-extend.ts:78-99` {two findings}
- **L4.** `wireBudgetHandler`/`wireTaskCompletedListener` in `director-construction.ts` are **dead** (imported only by their test) and have already drifted from the live inline copies in `director.ts`. `director-construction.ts:107-340`
- **L5.** `awaitTasks` adds one `task.completed` listener per id with no `setMaxListeners` → `MaxListenersExceededWarning`. `multi-agent-coordinator.ts:338-362`
- **L6.** `dep-watcher` debounce timers have no disposer/flush → leak on session/project switch. `dep-watcher.ts:177,194-224`
- **L7.** `mcp.control` (`MCPSection.sendMcpControl`) handled by neither server, absent from union — dead code. `MCPSection.tsx:316-327`
- **L8.** CLI embedded server stubs all MCP mutations (`success:false`) while standalone implements them → MCP panel mutations silently fail under `--webui`. `webui-server.ts:1780-1800`
- **L9.** `plan.template_use` handled by both servers but missing from the `WSClientMessage` union (orphan handler pair). `index.ts:2744-2774`
- **L10.** `iteration.started` omits `maxIterations` in the CLI server while standalone includes it. `webui-server.ts:763-770`
- **L11.** `model.switch` doesn't adopt the rejection-swallowing lock pattern → a failed write leaves `configWriteLock` rejected, poisoning later handlers. `index.ts:1943-1959`
- **L12.** Status watcher uses non-recursive `fsWatch` on the parent dir + may get `null` filename → `<hash>/status.json` changes unreliably delivered cross-platform. `setup-events.ts:428-466`
- **L13.** `fmtCost` omits the `$` for non-zero costs (`0.0123` vs `$0.0000`). `OfficeMapCanvas.tsx:108`
- **L14.** `performance.memory` read without type augmentation (Chrome-only) → shows misleading `0` on Firefox/Safari. `DebugDashboard.tsx:105-106`
- **L15.** MonitorDashboard mail list keyed by `${timestamp}-${i}` (array index) on a prepend list → remounts all rows each event. `MonitorDashboard.tsx:347-349`
- *(plus: `task.ts` planify returns zeros on the plan-path-missing path though the file is loaded `#55`; `task replace` doesn't validate id uniqueness `#56`; `goal.get` reads repo-local `.wrongstack/goal.json` violating the single-canonical-path invariant `#61`; POSIX-`/` path slicing in plan/task scope derivation fragile on win32 `#31`.)*

---

## ♻️ Refactor plan (high-value, low-risk)

1. **Single budget-policy module.** The timeout/idle heartbeat decision + per-kind grow-switch + ceiling magic numbers (1.5×, 50k/100k/5M/$100, 24 h) are copy-pasted across **four** sites that the architecture says must agree: `auto-extend.ts`, `director.ts`, `director-construction.ts`, `collab-debug.ts` — and they have **already drifted** (collab keys progress by `subagentId` alone vs the documented `subagentId:kind`; collab uses 1.25× in one branch). Extract `BUDGET_CEILINGS`, `growKind()`, and a shared `timeoutHeartbeatDecision()` into `subagent-budget.ts` (or `coordination/budget-policy.ts`); call from all four. **This collapses M3, L3, L4, #35, #57 and the must-agree invariant into one source of truth.** *(Findings #13, #34, #35, #42, #57)*
2. **`_negotiateExtension` should call `patchLimits`.** It re-implements the documented single-write-path inline (two copies of the six-field patch). One-line fix: replace the inline block with `this.patchLimits(ext);`. *(#57)*
3. **Decompose `executeWithTimeout` (272 lines).** Extract a `TimeoutWatchdog` helper + a shared `awaitBudgetDecision()` reused by `_negotiateExtension`. *(#36)*
4. **Unify the two WebUI servers.** The CLI embedded server (`webui-server.ts`) and standalone server (`index.ts`) duplicate `setupEvents`, prefs seeding/`persistPrefsToConfig`, `git.info`, and ~2100 lines of inline `handleMessage` cases that the CLI server already delegates to `ws-handlers/*`. They have **already drifted** (this is the root cause of C1, H5, M5, M6, M7, M13?, L8–L10). Promote the per-group handler modules + a shared `buildEventForwarders()` into `@wrongstack/webui/server` (use `@wrongstack/core` **subpaths**, not the browser-unsafe barrel) so both entry points share one implementation. *(#37, #38, #58, #59)*
5. **Cleanup:** the deleted `SkillsPanel.tsx` has **no** dangling live references (clean removal); only stale prose in comments/`TESTING.md`/`vitest.config.ts` mentions it. *(#60)*

---

## Notes
- `mcps/dfmt/` (11 MCP tool-def JSONs) was left in place — untracked, not a debug artifact. Decide whether to commit or remove.
- 10 candidate findings were **refuted** by the verifiers and are not listed.

---

## ✅ Resolution (fixes applied — `main`, uncommitted, verified)

Verified: every touched package typechecks; **core 894+641 / tools 34 / cli 1739 / tui+webui 550 tests pass; 0 regressions**. (The only failing tests — `budget-edges-t1-t4`, `subagent-budget-edges` D3, `watchdog-guard` — were already red on the pre-existing baseline; see "Deferred".)

**FIXED:** C1 · H1 H2 H3 H5 H6 H8 · M1 M2 M5 M6 M7 M8 M9 M10 M11 M12 M13 M14 M15 M16 · L1 L2 L5 L6 L7 L9 L10 L11 L12 L13 L14 L15 · #31 #55 #56 · refactor #5 (SkillsPanel confirmed clean).

**Also completed (not in the 61 — pre-existing broken WIP that blocked the build):** created the missing `@wrongstack/tools/tool-icons` data module (+tsup entry +package export) that `tool-icon.ts`/`tool-glyph.ts` imported; added the `Performance.memory` ambient type.

### Round 2 (after "continue" — opted into all deferred tracks)

**H7 — now FIXED.** `savePlan`/`saveTasks` return `boolean` (still emit `storage.error` + warn, still no-throw → the test-enforced graceful contract holds); `mutatePlan`/`mutateTasks` throw on a failed persist; `planTool`/`taskTool` (and taskify/planify cross-writes) catch → `ok:false` with the real reason instead of falsely claiming success. Verified: storage 628 + tools 34 tests pass.

### Round 3 (budget subsystem — partial)

The concurrent editor is isolated to the **compaction** subsystem (`execution/*-compactor.ts`, `models/llm-selector.ts`), so `coordination/` was safe to touch. Done:
- **Fixed `watchdog-guard.test.ts` parse error** — `await import(...)` sat inside non-`async` `it()` callbacks (lines 107/150/183), so the whole file failed to parse and its tests never ran. Now they run (revealing the real gaps below).
- **Fix A** — `checkLimits` now applies the `_watchdogActive` guard (conditioned on a handler being set), matching `checkTimeout`. Previously an idle trip re-added the `timeout` kind, defeating the watchdog dedup. Greens the "no-ops without a handler" + "exactly ONE timeout per crossing" tests. **Zero regressions** (896 coordination tests pass; `subagent-budget.test.ts` invariant tests intact).

**Still DEFERRED — needs YOUR architectural decision (an unresolved contradiction in your own WIP):**
- The remaining 9 visible failures (`budget-edges-t1-t4` T1/T4, `watchdog-guard` skip/resume/deadline/idle, `subagent-budget-edges` D3) require **relaxing the documented "no listener → `BudgetExceededError`" enforcement invariant** so a handler runs without a bus listener (your new `watchdog-guard`/T4 tests require this) — **but `subagent-budget.test.ts:173` + CLAUDE.md still assert the OLD behavior.** That contradiction is yours to resolve (update the invariant + that test + CLAUDE.md). It also needs the `executeWithTimeout` watchdog to re-emit the deadline event + return the right idle-abort status. I won't change a documented invariant or reconstruct the 272-line state machine unilaterally. H4 per-kind reporting belongs in your `_negotiateExtension` rewrite.
- **L8** — high-effort/low-value under current constraints (embedded server already returns a clear `mcp.operation_result{success:false}`, not silent).
- **Two-webui-server unification (#37/#38/#58/#59)** — concrete drift *bugs* (C1/H5/M5/M6/M7) already fixed in place; the ~2100-line de-dup is the highest-risk refactor and unsafe under concurrent editing of `server/index.ts`.

> **Live note:** the build is currently red from a **concurrent (non-Claude) edit** to `packages/core/src/models/llm-selector.ts` (an unguarded `noUncheckedIndexedAccess` access) — NOT from any change here. Every change in this session typechecks; that one file is the other editor's to finish.

**Scratch cleanup:** ~24 root debug files deleted; `mcps/dfmt/` preserved.

### Round 4 (server unification — incremental, verified)

The build is only *partially* blocked — a fresh **core** build fails on the concurrent `llm-selector` edit, but webui builds and CLI typechecks against the existing core dist, so unification IS verifiable.
- **#37 git.info — DONE (both sides).** Extracted the duplicated handler into a new shared `packages/webui/src/server/git-handlers.ts` (`handleGitInfo`), exported from `@wrongstack/webui/server`. Both servers now delegate — no more drift on ahead/behind or insertion/deletion parsing. Verified: webui 1058 + CLI 1739 tests pass, both typecheck clean.
- **#59 prefs Telegram drift — FIXED.** The CLI embedded server's `PREF_KEYS`/seed/`persistPrefsToConfig` were missing the Telegram keys (`tgConfigured`/`tgSessionEnd`/`tgDelegate`/`tgLongToolMs`) the standalone handles — Telegram notification settings silently didn't persist under `wrongstack --webui`. Added all three. Verified.

**Still deferred:** #58 (full `setupEvents` unification) and #38 (~2100-line inline-handler de-dup). Their concrete drift *bugs* (H5, L10) are already fixed in place; remaining value is pure future-drift-prevention at high refactor risk — best as dedicated PRs.
