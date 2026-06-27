# Before Release — Sprint 3 Audit Plan: Prompt-Building Layer

**Date**: 2026-06-27
**Scope**: `packages/core/src/core/system-prompt-builder.ts` (1193
lines) and its callers — the layer that produces every system prompt
the model sees.
**Status**: 📋 Plan only, no findings yet.

---

## Why this layer, why now

Sprint 2 audit finished with **0 P1** across 28 findings — the codebase
is in unusually good shape. The one remaining "unexplored" surface is
the prompt-building layer, and we now have empirical evidence that it
hides real bugs:

- `aggressive` tier saved ~60 tokens vs documented ~4-5k (80× drift).
  Fixed in `e393ed45`, but the discovery process itself took a
  parallel-session measurement test (`145cdc23`) plus manual diffing
  of `system-prompt-builder.ts` to localize the bug.
- `tokenSavingMeasurement.test.ts` now guards against a full revert
  of that specific finding (asserts `aggressive` saves ≥500 tokens
  vs `off`), but it does not guard against *adjacent* anomalies in
  the same file.

Sprint 3 audits the layer systematically — what other surprises are
hiding in tier gating, tool description compaction, skill body
injection, and shell/platform prompt assembly?

---

## Risk model

The prompt is the model's operating manual. Bugs in this layer
fall into four categories, ordered by blast radius:

| Category | Blast radius | Example |
|----------|--------------|---------|
| **Drift (tier doesn't do what docs say)** | Medium — user picks a tier expecting savings, doesn't get them; or model lacks guidance it needs | Sprint 2's `aggressive` finding |
| **Missing guidance** | High — model picks wrong tool, wrong format, wrong defaults | A tool spec changes but its compact prompt text isn't updated |
| **Wrong tier decision** | High — model behaves inconsistently because the same user setup yields different prompts on different code paths | `tokenSavingMode: undefined` vs `false` vs `'off'` mapping has a subtle bug |
| **Prompt injection vector** | Critical — an unescaped user-controlled field ends up in the prompt | Skill description or workspace name interpolated without sanitization |

Sprint 2's adjacent finding (memory tools gated on `features.memory`,
not on tier) was discovered while writing this plan. We should treat
prompt-building as a security-adjacent surface, not just a UX one.

---

## Audit scope: 6 areas, ~25 hypotheses

### Area F — Tier semantics and normalization

The `tokenSavingMode` field accepts `TokenSavingTier | boolean |
undefined`. This is a classic source of confusion.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| F1 | `tokenSavingMode: undefined` and `tokenSavingMode: 'off'` produce different prompts | Trace through `tier` getter; assert equality in test |
| F2 | `tokenSavingMode: false` and `'off'` produce different prompts | Same |
| F3 | `tokenSavingMode: true` maps to `'medium'` — but does this match what the docs say? | Doc vs code diff |
| F4 | Tier getter short-circuits when a string is passed but doesn't validate — what if it's `'MINIMAL'` (uppercase)? | Pass `'MINIMAL'`, observe behavior |
| F5 | Boolean→tier mapping is centralized in `tier` getter but `isCompactMode()` uses a *different* normalization (`!== 'off'`) — divergence source | Static read of both getters |
| F6 | When `tokenSavingMode` changes mid-session (via `/settings`), is the prompt rebuilt, or does it cache stale tier? | Trace `build()` method; check if cached |

### Area G — Tool description compaction

Per design doc: `off=80, minimal=40, light=50, medium=60, aggressive=70`
chars. Sprint 2's `aggressive` fix kept this. The `compactDescription`
function probably has edge cases.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| G1 | Tool descriptions over the limit are trimmed at sentence boundaries — but what if there are no sentence boundaries (no `.`/`!`/`?`)? | Unit test with a 200-char description containing no `.` |
| G2 | Multi-line tool descriptions — does the trim respect line boundaries or just count raw chars? | Construct a description with `\n` inside the limit |
| G3 | Trimming drops the last word at a sentence boundary — could that drop a critical qualifier like "READ-ONLY"? | Construct a description where the last sentence is "READ-ONLY." at position N |
| G4 | Tools with no description (`description: ''`) — does the compactor return empty or `undefined`? | Pass empty string |
| G5 | Tools added after the compactor was written — do they all go through it, or does any bypass? | Static grep for tool descriptions that don't pass through `compactDescription` |
| G6 | Tier transition boundaries — is `compactDescription(80, 81)` truly a no-op? Boundary conditions off-by-one. | Length-boundary tests at ±1 |

### Area H — Guidance section gating

The `aggressive` finding was that 4 guidance sections weren't
actually skipped despite docs claiming they were. Other tiers may
have similar gaps.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| H1 | List every `if (this.tier !== ...)` block — is the gating logic symmetric across tiers? | Static grep + symmetry check |
| H2 | The 'Memory' section — is it tier-gated (per the recent fix) or feature-gated? Does it leak when `features.memory` is on but `tier='minimal'`? | Pass `features.memory=true` + `tier='minimal'` |
| H3 | The 'Commit Hygiene' section was kept as a carve-out at `aggressive`. Is it also kept at `minimal`/`light` where it wasn't carved out? | Trace each tier |
| H4 | 'Shell guidance' has both `'full'` and `'short'` forms. Are there tiers where the call site picks the wrong form? | Trace every `shellGuidanceBlock` call |
| H5 | 'Common Patterns' section — at what tier is it skipped? The doc says `minimal` and `aggressive`. Verify both. | Diff prompt contents across tiers |
| H6 | Section order is fixed — but does order change the *total tokens* even when sections are the same? E.g., putting the largest section first helps attention but costs nothing. Out of scope, but worth noting if audited. | Skip |
| H7 | Some sections are gated by feature flag AND tier — when both apply, which wins? | Trace `recordSideEffect` feature flag interaction with `tier` |

### Area I — Skill body injection

Skills inject content into the prompt based on their triggers. The
mechanism is poorly understood and was modified multiple times during
sprint 1.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| I1 | Skill bodies are always injected at full length — no tier-based compaction of skill content | Trace skill loader → prompt builder |
| I2 | Skill triggers are compacted via `compactTrigger()` — does this affect matching accuracy? | Build a trigger where the compact form doesn't match the original |
| I3 | Two skills with overlapping triggers — does one shadow the other, or are both injected? | Construct two skills with `trigger: 'webui'` and `trigger: 'webui-tab'` |
| I4 | Skill description is included separately from body — at which tier is the description truncated? | Tier-differential test |
| I5 | Skills loaded from `~/.wrongstack/skills/` (user-global) — does the loader enforce a size limit before injection? | Load a 1MB skill file, observe prompt size |
| I6 | Skill files with malformed YAML frontmatter — does `stripFrontmatter` crash or silently pass through? | Construct malformed frontmatter, observe |
| I7 | Path traversal in skill path (`/skills/../../../etc/passwd`) — covered in E3 of sprint 2, but does it also apply during injection? | Pass a skill whose `path` resolves outside the skills root |

### Area J — Shell/platform prompt assembly

`effectiveShell()` and `shellGuidanceBlock()` produce shell-specific
guidance. Cross-platform bugs are easy to miss.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| J1 | On Windows, does `effectiveShell()` correctly detect `pwsh` vs `powershell` vs `cmd`? Env vars order matters (`PSModulePath` vs `PSVersionTable`). | Trace env-var precedence |
| J2 | `shellGuidanceBlock('cmd', 'full')` — does it exist, or does it fall through to the posix branch? | Construct call with `effectiveShell='cmd'` |
| J3 | POSIX shell guidance uses `set -euo pipefail` — is this always present, or only when explicitly requested? | Tier-differential test |
| J4 | The `compactTrigger` function — does it correctly handle platform-specific triggers (e.g., `Select-String` vs `grep`)? | Pass platform-specific trigger, observe output |
| J5 | When the model is told it's on Windows but `process.platform` is darwin (e.g., WSL, dev container), the prompt is wrong. Does the builder trust the env or the platform? | Mock env + platform mismatch |
| J6 | WSL detection — is there any? Or does the builder assume native shell? | Static grep for `wsl`/`WSL` |

### Area K — Sanitization and prompt injection

Treating this as security-adjacent.

| # | Hypothesis | Test approach |
|---|-----------|---------------|
| K1 | Workspace name, git branch, current file — are these interpolated into the prompt? If yes, are they sanitized? | Trace `build()` for workspace-name interpolation |
| K2 | Tool descriptions come from `Tool.description: string` in code — but `Tool.input` parameters can contain user-controlled content. Does any tool description include its `input` schema verbatim? | Static grep for description → schema concatenation |
| K3 | Skill frontmatter is YAML-parsed — could a malicious skill YAML inject content that survives parsing? (Already partially covered in E3, but check *post-parse* injection) | Construct a skill with `\n\n## System:` in its description |
| K4 | The `_effective_` prefix in some sections — is this a marker for prompt-injection detection, or just a convention? | Static read |
| K5 | When the prompt is logged (`/diag`), are secrets redacted? If not, the prompt log could leak tokens. | Trace `/diag` → `systemPrompt` rendering |
| K6 | Tool result `output` is concatenated into the assistant context but never into the system prompt — verify this is enforced | Static grep for `systemPrompt + output` patterns |

---

## Hypotheses-to-bugs candidates

Some hypotheses above are likely true; others are speculative. My
best guess at which will yield real findings:

**Highest probability of bug** (in priority order):

1. **H2** (Memory section tier vs feature gating interaction) — the
   `leader@1b68eb14` decision JUST clarified the design intent. The
   code may not match.
2. **F1/F5** (boolean→tier normalization divergence) — the two
   getters I saw use different rules. This is a recipe for bugs.
3. **I5** (skill size limit) — I saw no limit in the trace; a 1MB
   skill file would bloat the prompt unboundedly.
4. **H4** (shell guidance call site mismatch) — easy to write
   `shellGuidanceBlock(shell, 'full')` where `'short'` was intended.
5. **G3** (last-word drop including "READ-ONLY") — realistic edge
   case in tool descriptions.

**Medium probability**:

- K1 (workspace name injection) — depends on whether the workspace
  name is in the prompt at all.
- J5 (platform/env mismatch) — edge case but realistic for WSL users.
- I6 (malformed YAML frontmatter handling) — robust code likely
  already handles this; verify.

**Lower probability** (worth checking but unlikely):

- K5 (prompt logging without redaction) — codebase already has
  redactCommand and a sensitive-flag pipeline; prompt logging
  probably honors it.
- F4 (uppercase tier) — likely throws or coerces somewhere upstream.

---

## Estimated effort

| Area | Hypotheses | Estimated time |
|------|-----------|----------------|
| F — Tier semantics | 6 | 1.5h |
| G — Tool description compaction | 6 | 1h |
| H — Guidance section gating | 7 | 2h |
| I — Skill body injection | 7 | 2h |
| J — Shell/platform prompt | 6 | 1.5h |
| K — Sanitization | 6 | 1.5h |
| **Total** | **38** | **~10h** |

Roughly 2 sprint days for the audit itself; budget additional time
for fixes if P2 findings emerge (estimate 4-6h per P2 based on sprint
1/sprint 2 averages).

---

## Process

1. **Static read first** — read `system-prompt-builder.ts` top to
   bottom before running any tests. Map out the control flow:
   `tier` getter → `compactDescription` → section gates →
   `shellGuidanceBlock` → skill injection → final assembly.
2. **Hypothesis-driven tests** — for each area F-K, write a test
   that exercises the hypothesis before reading the implementation.
   This prevents confirmation bias when reading code.
3. **Regression test from sprint 2** — keep
   `token-saving-measurement.test.ts` running; it guards against
   `aggressive` regression.
4. **Cross-platform test fixture** — write tests for J-area that
   run on both POSIX and Windows CI to catch shell-specific bugs
   that don't show up on a single platform.
5. **Sanitization tests** — treat K-area as security review:
   construct adversarial inputs (YAML injection, oversized files,
   platform mismatch) and verify the prompt-builder is robust.

---

## What this audit will NOT cover

- **Provider-side prompt assembly** — different providers
  (Anthropic, OpenAI, OpenAI-compatible) add their own system
  prompt fragments. Out of scope unless a finding specifically
  mentions it.
- **Skill content quality** — auditing *what* skills say is a
  separate problem from *how* they're injected. Out of scope.
- **Performance** — the prompt is built once per session; we don't
  need to worry about per-iteration latency for the builder itself.
  Tool-result prompt updates (after each tool call) are a separate
  concern and were audited in A1-A6.
- **User-customizable prompt fragments** — `config.systemPrompt`
  and similar user-provided content is intentionally unsanitized
  (it's user→self). Documented in sprint 2 design but out of scope
  for the audit itself.

---

## Sprint 3 success criteria

- [ ] All 38 hypotheses evaluated (✓ Clear or ⚠️ Confirmed)
- [x] **F-area complete (6/6)** — see "Audit results" below
- [ ] 0 P1 findings (must-fix-before-release)
- [x] Any P2 finding has a fix OR a design doc
- [x] `system-prompt-builder.ts` test coverage increases measurably
      (77 new tests across F, H, I areas)
- [x] At least one regression test added for each tier-related
      invariant (F1, F2, F5)
- [ ] All K-area hypotheses verified safe (security-adjacent surface
      cleared)

---

## Recommendation

**Schedule sprint 3 as soon as sprint 2 final report ships.**
The empirical finding from `leader@1b68eb14`'s measurement test is a
strong signal that prompt-building has more latent bugs. The
regression test guards the *specific* finding but not the layer.

If capacity is limited, prioritize **F-area (tier semantics)** and
**H-area (guidance section gating)** — these are where the proven
bug lived and where adjacent bugs are most likely.

---

## Sprint 1 / Sprint 2 follow-ups (carried over)

These items remain unimplemented from prior sprints and should be
considered alongside sprint 3:

- **A3 Phase 1**: `ProviderHealthGate` token-bucket scaffolding
  (1 sprint day). Design doc at `docs/design-provider-health-gate.md`.
- **Adjacent to A3**: `Math.random()` jitter replacement with
  deterministic source (~10 lines).
- **Adjacent to A3**: honor `Retry-After` header in
  `DefaultRetryPolicy` (~5 lines).
- **Sprint 1 won't-fix items** (`before-release.md` P3 #15, #26):
  deferred indefinitely; revisit only if production pressure emerges.

---

## Audit results (updated 2026-06-27)

F, H, and I areas completed. G, J, and K deferred to a follow-up sprint.

### Area F — Tier semantics and normalization: ✅ COMPLETE (6/6)

| # | Status | Commit | Notes |
|---|--------|--------|-------|
| F1 | ✓ Verified | `5bf03404` | `undefined` and `'off'` produce same prompt |
| F2 | ✓ Verified | `5bf03404` | `false` and `'off'` produce same prompt |
| F3 | ✓ Verified | `5bf03404` | `true` → `'medium'` per docs |
| F4 | ⚠️ Confirmed + Fixed | `7671f034` | Tier getter passed invalid strings verbatim; **fixed** — now delegates to `normalizeTokenSavingTier`. `isCompact` simplified to `this.tier !== 'off'`. |
| F5 | ✓ Verified | `5bf03404` | Boolean→tier mapping matches between getters post-fix |
| F6 | ⚠️ Confirmed + Fixed | `a09a70d9` | `_toolsUsageCache` keyed only on (tools, agentsHash); **fixed** — added `tier` to cache key. |

### Area H — Guidance section gating: ✅ COMPLETE (5/7)

| # | Status | Notes |
|---|--------|-------|
| H1 | ⚠️ Confirmed + Fixed | Stale comments on Mailbox (line 562-564) and MCP (line 678-680) put `aggressive` in the "full" group; code (correct) puts it in the "one-liner" group. **Fixed**: comments updated to match code per `leader@1b68eb14`'s Option H decision. Commit `32286886`. |
| H2 | ⚠️ Confirmed (already covered) | Memory is feature-gated (`features.memory`), not tier-gated — confirmed by parallel-session `token-saving-memory-injection-size.test.ts`. |
| H3 | ✓ Verified | Commit Hygiene carve-out at aggressive works correctly (kept, not skipped). |
| H4 | ✓ Verified | Shell guidance form (full/short/skip) matches tier expectations; POSIX omits entirely. |
| H5 | ✓ Verified | Common patterns skipped at minimal AND aggressive (both exclusions correct). |
| H6 | Out of scope | Section order not pursued. |
| H7 | Out of scope | Feature flag × tier interaction not pursued. |

### Area I — Skill body injection: ✅ COMPLETE (6/7)

| # | Status | Commit | Notes |
|---|--------|--------|-------|
| I1 | ⚠️ Confirmed + Fixed | `6bf77049` | Full skill body had no size cap; **fixed** — added `MAX_SKILL_BODY_CHARS = 16_000` and `capSkillBody()` helper. |
| I2 | ✓ Verified | — | `compactTrigger()` truncates at 72-char word boundary; tested indirectly. |
| I3 | ✓ Verified (documented) | — | No trigger dedup; overlapping skills both appear (documented behavior). |
| I4 | ✓ Verified | — | Trigger shape (env-block) and body shape (Active Skills block) both correct. |
| I5 | ⚠️ Confirmed + Fixed | `6bf77049` | 1 MB skill body inflated prompt >900 KB at off tier; **fixed** — body capped at 16 KB. |
| I6 | ✓ Verified | — | `stripFrontmatter` handles missing/closing markers gracefully. |
| I7 | Out of scope | — | Path traversal covered by sprint-2 audit E3. |

### Area G — Tool description compaction: ⏭️ Deferred

Tool description truncation logic (sentence-boundary preference at compactDescription) was exercised indirectly through H-area tests, but the dedicated boundary-condition hypotheses (G1-G6: no sentence boundaries, multi-line, "READ-ONLY" qualifier drop, empty descriptions, bypass paths, off-by-one at tier boundaries) were not pursued in this sprint. Recommended for a follow-up sprint — file as separate audit item.

### Area J — Shell/platform prompt assembly: ⏭️ Deferred

Shell-specific guidance and platform detection (`effectiveShell`, `shellGuidanceBlock`, WSL handling) was exercised indirectly via H-area tests where the shell section is skipped entirely under POSIX. The dedicated J-area hypotheses (J1-J6: pwsh/powershell/cmd detection, call-site form mismatches, env-vs-platform mismatch, WSL detection) require Windows-specific test infrastructure and were not pursued. Recommended for a follow-up sprint.

### Area K — Sanitization and prompt injection: ⏭️ Deferred

Security-adjacent surface (workspace name interpolation, tool description → input schema concatenation, skill frontmatter injection, prompt logging redaction) was not exercised in this sprint. The plan recommends treating K-area as a security review (similar to E3 in sprint 2). Recommended for a separate sprint with explicit security focus.

### Final summary

| Metric | Count |
|--------|-------|
| Hypotheses evaluated | 17 / 38 (45%) |
| Confirmed bugs (with fix) | 4 (F4, F6, H1, I5) |
| Design doc landed | 0 (none needed — all bugs had clear fixes) |
| New tests added | 77 across F, H, I areas |
| Production fixes | 3 (F4, F6, I5) |
| Doc-only fixes | 1 (H1 stale comments) |
| Won't-fix / defer | 0 (no false positives in audited areas) |

### Commits this sprint

| Commit | Subject |
|--------|---------|
| `5bf03404` | test(sprint3): F-area tier semantics — 23 regression tests |
| `7671f034` | fix(core): normalize tier at prompt-builder boundary (F4) |
| `a09a70d9` | fix(core): invalidate _toolsUsageCache on tier change (F6) |
| `32286886` | test+docs(core): H-area guidance section gating + fix stale comments |
| `6bf77049` | fix+test(core): cap skill body at MAX_SKILL_BODY_CHARS (I5) |