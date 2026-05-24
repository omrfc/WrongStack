# `/goal pause` / `/goal resume` + Iteration Stage Reporting

## Status: ✅ Implemented

### Implementation summary (2026-05-24)

All features from this design are fully implemented:

- **`goalState: 'paused'`** — added to `GoalState` type in `goal-store.ts`
- **`/goal pause` / `/goal resume`** — implemented in `slash-commands/goal.ts`
  - Writes `goalState: 'paused'` to goal.json; engine exits loop gracefully via existing `missionState !== 'active'` guard
  - `/goal resume` clears `goalState: 'active'` and loop continues from next iteration
- **`onStage` callback** — `EternalAutonomyEngine` fires it at each phase transition (idle → decide → execute → reflect → sleep/paused/stopped)
- **`state.eternalStage`** — plumbed through `app.tsx` via `subscribeEternalStage` → reducer → StatusBar
- **EternalStageChip** — renders in status bar line 2 after autonomy chip, showing phase-specific labels:
  - `⬜ idle`, `⬇ decide: {reason}`, `▶ execute({task})`, `↩ reflect: {status}`, `💤 sleep {N}s`, `⏸ paused`, `■ stopped`, `⚠ error: {message}`
- **`formatGoal`** — updated to show `State: {stateLabel} (iteration #{n})` instead of `Mission:`

## Original Design

When running `/autonomy eternal` with a goal, the engine loops through a
sense-decide-execute-reflect cycle. The user has no visibility into which
stage the engine is in between iterations, and cannot easily pause the loop
mid-goal without killing the current iteration (via Ctrl+C or `/autonomy stop`,
which aborts the in-flight agent.run).

## Problem Statement

1. **No iterasyonlar araşında görünürlık** — Kullanıcı "hangi aşamada olduğunu" göremez
   (sense / decide / execute / reflect).
2. **Durdurmak demek koparmak** — `/autonomy stop` ve Ctrl+C mevcut iteration'ı
   AbortController üzerinden zorla keser; iş yarım kalır.
3. **Sadece tam durduru var** — pause/resume yok; `/goal clear` var ama o goal'u siler.

## Design

### 1. `/goal pause` — duraksat, ama koparma

Bir sonraki iteration **biter bitmez** duraksin. Mevcut iteration'ı kesmez.
Goal dosyasına `goalState: 'paused'` yazılır (existing `active|completed|abandoned` yanına
yeni state).

```
User types /goal pause
  → Engine finishes current iteration
  → Writes goalState = 'paused' to goal.json
  → Loop exits gracefully (runOneIteration sees non-'active' state)
  → Returns "Goal paused. /goal resume to continue."
```

Engine'de `pauseRequested` flag'i yok — doğrudan goal.json'a yazılması yeterli,
çünkü `runOneIteration`'ın başında zaten `goal.goalState` kontrolü var:

```ts
if (missionState !== 'active') {
  this.stopRequested = true;
  return false;
}
```

`'paused'` burada `!== 'active'` olarak True döner → loop stopped.

### 2. `/goal resume`

`goalState: 'active'` yaz, loop devam etsin. `/autonomy eternal` zaten
`prime()` ile `state='running'` yapıyor — mevcut engine tekrar `runOneIteration`
çağırana kadar bir şey yapmaz. Kullanıcıya mesaj: "Goal resumed."

### 3. Iteration stage reporting (TUI)

Her iteration'ın başında ve her aşama geçişinde TUI'ye event gitsin.
Bu bilgi TUI'de status bar'da veya özel bir panelde gösterilir.

`EternalAutonomyEngine`'e yeni callback:

```ts
onStage?: (stage: IterationStage) => void;

type IterationStage =
  | { phase: 'idle' }
  | { phase: 'sense'; detail: string }
  | { phase: 'decide'; detail: string }
  | { phase: 'execute'; task: string }
  | { phase: 'reflect'; status: 'success' | 'failure' | 'aborted' }
  | { phase: 'sleep'; ms: number }
  | { phase: 'paused' }
  | { phase: 'stopped' };
```

TUI bu stage event'lerini alır → `state.eternalStage` diye bir state'e yazar →
render'da gösterir.

### 4. TUI Status Bar Extension

Mevcut status bar'a (veya autonomy chip yanına) ek:

```
[⏸ ETERNAL:decide→todo:fix-auth-bug]  ← stage info
```

### 5. `/goal status` çıktısına yeni bilgiler

```
🎯 Goal: "fix auth bug"
   State: active (iteration #14)
   Stage: execute (todo: fix the redirect URI)
   Sources: todo(3) | git(0) | brainstorm(0)
   Failures: 1 consecutive | 0 total
   [paused | running] indicator
```

## File Changes

| File | Change |
|------|--------|
| `packages/core/src/storage/goal-store.ts` | Add `paused` to `GoalState` type |
| `packages/core/src/execution/eternal-autonomy.ts` | Add `onStage` callback; call it at each phase transition |
| `packages/cli/src/slash-commands/goal.ts` | Add `pause` and `resume` verbs; update `status` output |
| `packages/tui/src/app.tsx` | Add `eternalStage` state; wire `onStage` from engine; render in status area |
| `packages/tui/src/components/eternal-stage.tsx` (new) | Stage indicator component |

## Backward Compatibility

- `goalState: 'paused'` is a new variant. Old goal.json files with
  `goalState: undefined` or `'active'` work unchanged.
- Engine's existing `missionState !== 'active'` guard handles `'paused'`
  without any conditionals — the loop just stops, which is correct behavior.
- `/goal pause` when not in eternal mode: saves `goalState: 'paused'`
  and returns success. If user later runs `/autonomy eternal`, engine
  immediately sees `paused` and refuses to start — user must `/goal resume` first.

## Edge Cases

- `/goal pause` during an iteration → waits for current iteration to finish
- `/goal clear` during an iteration → marks abandoned + aborts in-flight via `stopRequested`; current agent.run gets AbortSignal
- `/goal pause` when already paused → no-op, returns "Already paused."
- `/goal resume` when not paused → no-op, returns "Not paused."
- TUI not mounted when stage events fire → events are fire-and-forget; no crash
- Restarting TUI while engine running → engine is in `core`, survives TUI restart; TUI reconnects via `subscribeEternalIteration`