# Kalan Görevler — WrongStack AutonomousCoordinator

Tarih: 2026-06-17

---

## Bugün Yapılanlar (Tamamlandi ✅)

| # | Görev | Commit |
|---|-------|--------|
| 1 | TUI timeline gap fix — `_emit()` + 6 event yayınlama noktası | `01bb3518` |
| 2 | Orphan retry limit (maxBidRetries: 3) — sonsuz döngü önlendi | `01bb3518` |
| 3 | Explicit teardown (finally bloğu) — Ctrl+C sonrası temizlik | `01bb3518` |
| 4 | Dead code cleanup (`quorum_not_met` + `@deprecated`) | `01bb3518` |
| 5 | `autonomous-coordinator.test.ts` — 16 test | `6e3d219d` |
| 6 | Orphan retry testleri (fake timers) — 3 test | `6e3d219d` |
| 7 | TUI reducer testi — 13 test (timeline icon/kind/count/slice) | `b0c3a076` |
| 8 | `git push` — 5 commit remote'a gönderildi | — |
| 9 | TUI event chain testi — 🎯⚡💡 ikonları doğrulandı | — |
| 10 | `#1` coordinator run() fix — `graph.load()` try içine alındı + `.catch()` | `31e0ee87` |
| 11 | Temp test dosyaları temizlendi | — |
| 12 | `#2` orphan retry TUI fix — `task:failed` fleet filter eklendi → `goal:failed` ❌ | `74572126` |
| 13 | `#3` teardown — `stop()` log eklendi + unit test | `f99aae03` |

---

## Root Cause — `#1` Coordinator `run()` Çalışmıyor

**Bulunan Kök Neden:** İki ayrı bug birlikte çalışıyordu:

### Bug 1: `graph.load()` try bloğunun dışındaydı

```typescript
// ÖNCE (HATALI)
async run(opts) {
  await this.graph.load();  // ← try DIŞINDA! throw yakalanmıyor

  try {
    const goalConfigs = await this._decomposeGoal(goal);  // ← hiçbir zaman ulaşılamıyor
    ...
  }
}

// SONRA (DÜZELTİLDİ)
async run(opts) {
  try {
    await this.graph.load();  // ← try İÇİNDE — artık throw yakalanıyor
    const goalConfigs = await this._decomposeGoal(goal);  // ← çalışıyor!
    ...
  }
}
```

### Bug 2: `void autonomousCoordinator.run()` promise rejection'ı yutuyordu

```typescript
// ÖNCE (HATALI)
onCoordinatorStart: (goal) => {
  void autonomousCoordinator.run({ goal });  // ← Promise rejection sessizce yutuluyor
}

// SONRA (DÜZELTİLDİ)
onCoordinatorStart: (goal) => {
  autonomousCoordinator.run({ goal }).catch((err) => {
    console.error('[coordinator] run() failed:', err);  // ← artık hata görünüyor
  });
}
```

**Test sonuçları:** `run()` testlerde düzgün çalışıyor — `_decomposeGoal` çağrılıyor, sub-goals yayınlanıyor, autonomous loop giriliyor.

---

## Kalan Görevler

### 2. ✅ Orphan Retry — `goal:failed` TUI İkonu — DÜZELTİLDİ

**Bulunan Kök Neden:** Coordinator `task:failed` event'ini dinlemiyordu. Auctioneer'da task max bid retries aşımında `task:failed` emit ediyordu ama coordinator bunu duymuyordu → `goal:failed` TUI'ye hiç gönderilmiyordu → ❌ ikonu görünmüyordu.

**Düzeltme:** `autonomous-coordinator.ts` constructor'ına `task:failed` fleet filter eklendi:

```typescript
// Wire task:failed from auctioneer — emits goal:failed for orphan tasks
this.fleet?.filter('task:failed', (e: FleetEvent) => {
  const payload = e.payload as { taskId: string; error: string } | undefined;
  const taskId = payload?.taskId;
  if (!taskId || this._handledBySubagent.has(taskId)) return; // double-emission önleme
  this._handledBySubagent.add(taskId);
  this._emit({ type: 'goal:failed', goalId: taskId, text: payload?.error ?? 'Task failed' });
});
```

**Test:** Unit test eklendi — `task:failed → goal:failed` propagasyonu doğrulanıyor (18/18 coordinator testleri geçiyor).

**Kalan:** End-to-end test için `node-pty` gerekiyor (Windows'da Blessed PTY yok).

---

### 3. ✅ Teardown — `coordinator.stop()` Log Doğrulaması — DÜZELTİLDİ

**Durum:** `execution.ts:1837`'de `finally` bloğuna `deps.onCoordinatorStop?.()` ekli. `stop()` metoduna log eklendi.

**Düzeltme:** `autonomous-coordinator.ts:311-314`:
```typescript
stop(): void {
  if (!this.running) return;
  this.running = false;
  console.error(`[AutonomousCoordinator] stop signal received — shutting down (iteration ${this.iterationCount})`);
}
```

**Test:** `coordinator-stop.test.ts` — 2 unit test (log emission + idempotency). stderr'de `[AutonomousCoordinator] stop signal received` log'u görülüyor.

**Kalan:** Ctrl+C sonrası manual doğrulama (PTY gerekiyor).

---

### 4. ✅ `ask_human` Brain Kararı — KASITLI TASARIM (kapatıldı)

**Durum:** `ask_human` type'ı AutonomousBrain tarafından üretilmez — bu **kasıtlıdır**.

**Açıklama:**
- `AutonomousBrain` → tamamen otonom çalışır, LLM `answer` veya `deny` döner
- `BrainDecisionQueue` → insan kararı gerektiğinde `ask_human` üretir
- `HumanEscalatingBrainArbiter` → inner brain `ask_human` döndüğünde kuyruğa yönlendirir
- `AutonomousCoordinator` → `ask_human` alırsa `autonomous:ask_human` event'i emit eder (TUI'ye bildirim)
- WebUI → `brain.decision_ask_human` event'ini dinler ve browser'a iletir

**Karar:** Type'dan kaldırmaya gerek yok — `ask_human` geçerli bir decision type, sadece AutonomousBrain değil `BrainDecisionQueue` üretiyor.

---

## Temizlik Tamamlandı ✅

- `test-tui-icons.cjs` — silindi
- `test-orphan-retry.cjs` — silindi
- `test-orphan-retry-debug.cjs` — silindi
- `test-decompose-quick.cjs` — silindi
- `test-event-chain.cjs` — silindi
- `test-tui-pty.cjs` — silindi
- Debug console.error logları temizlendi (autonomous-coordinator.ts)

---

## Öncelik Siralamasi

```
1. [YUKSEK] #2 — orphan retry testi (artık test edilebilir)
   → #1 çözüldüğü için `_decomposeGoal` çalışıyor

2. [ORTA]  #3 — teardown manual doğrulama
   → Sadece manual olarak yapılabilir

3. [DUSUK] #4 — ask_human type decision
   → Istege bagli
```

---

## Commit Ozeti (Bugün)

```
f99aae03 feat(coordinator): add stop() log, task:failed fleet filter, and unit tests
74572126 fix(coordinator): fix coordinator orphan retry: subscribe to task:failed fleet events
31e0ee87 fix(coordinator): graph.load() inside try block + proper error handling
01bb3518 feat(coordinator): event emission, orphan retry, teardown, dead code
6e3d219d test(autonomous-coordinator): orphan retry tests with fake timers
b0c3a076 test(tui): coordinator reducer tests for timeline mapping
```

---

## Notlar

- TUI interaktif terminal gerektirdiği için bazı testler manual yapılmalı
- Windows'da PTY olmadığından Blessed TUI stdout'a ansi escape sequence basıyor — bu yakalanabiliyor ama güvenilir değil
- node-pty yüklü değil — yüklenirse interaktif test mümkün olur: `pnpm add -D node-pty`
- CLI build: `pnpm --filter @wrongstack/cli build` başarıyla çalışıyor ✅
