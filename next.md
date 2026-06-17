# Kalan Görevler — WrongStack

Tarih: 2026-06-17 (Session 2 — Test Infrastructure)

---

## Tüm Görevler Tamamlandi ✅

### AutonomousCoordinator (Session 1)
- `#1` run() decompose çalışmıyordu — `graph.load()` try içine alındı ✅
- `#2` orphan retry ❌ ikonu — `task:failed` fleet filter eklendi ✅
- `#3` teardown — `stop()` log + unit test eklendi ✅
- `#4` `ask_human` — kasıtlı tasarım, kapatıldı ✅
- `#5` debug kod temizliği — tüm debug dosyaları silindi ✅

### Test Infrastructure (Session 2)
- `release:check` — webui testleri root config'ten hariç tutuldu ✅
- WebUI coverage artışı — 8 yeni test dosyası, %100'e ulaşan store'lar ✅
- Coverage ratchet policy — +1 per new store test, TESTING.md oluşturuldu ✅
- E2E altyapısı — Playwright kuruldu, smoke test yazıldı ✅
- E2E test genişletme — SkillsPanel, AgentFlowCanvas, ChatInput (22 test) ✅

---

## Mevcut Durum

### Test Sonuçları
| Suite | Dosyalar | Testler | Başarısız |
|-------|----------|---------|-----------|
| Root workspace | 604 | 8,480 | 0 ✅ |
| WebUI unit | 61 | 1,037 | 0 ✅ |
| WebUI E2E | 3 | 22 | 0 ✅ |
| **Toplam** | **668** | **~9,539** | **0** ✅ |

### Coverage
| Metric | Measured | Threshold |
|--------|----------|-----------|
| Statements | 19.21% | 19 |
| Branches | 16.87% | 16 |
| Functions | 17.81% | 17 |
| Lines | 19.83% | 19 |

### %100 Unit Coverage'a Ulaşan Dosyalar
`goal-store`, `file-store`, `history-store`, `session-store`, `viz-store`,
`fleet-store`, `code-detect`, `slash-commands`, `ui-store`, `provider-store`,
`chat-store`, `local-prefs-migration`

### %100 Hedefi İmkansız Olanlar (E2E gerektirir)
`server/index.ts` (3,652 LOC), `SkillsPanel.tsx` (1,567 LOC),
`AgentFlowCanvas.tsx` (942 LOC), `ChatInput.tsx` (532 LOC), `ws-client.ts` (724 LOC)

---

## Commit Ozeti (Session 2)

```
78f4f4d1 fix(webui): TESTING.md table thresholds
08f9fe57 test(webui): coverage ratchet policy + TESTING.md
7853c543 test(webui): E2E component tests for SkillsPanel, AgentFlowCanvas, ChatInput
c9d61da6 test(webui): E2E smoke test with Playwright infrastructure
409748f5 test(webui): goal-store, local-prefs, config-store unit tests
60a5335e test(webui): fleet-store coverage 71% → 91% (38 tests)
eaaf75f0 test(webui): coverage thresholds, file/history/session store tests
5135e5c2 fix(release): webui tests excluded from root vitest.config.ts
dd16572f fix(release): test script runs both root + webui tests
```

---

## Açık Görevler

Yok — tüm kritik görevler tamamlandı.

### İsteğe Bağlı İyileştirmeler
1. `server/index.ts` handler parçalama — büyük dosya, E2E test gerekli
2. Coverage thresholds +1 ratchet — her yeni store testinde uygula
3. Daha fazla E2E test — `FleetMonitor`, `InspectorPanel`, `QueuePanel`
4. `local-prefs` migration — zustand/persist internals zor test ediliyor
5. `ws-client.ts` — WebSocket wrapper, E2E ortamında test edilmeli
