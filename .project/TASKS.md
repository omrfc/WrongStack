# WrongStack — TASKS

**Companion to:** `SPECIFICATION.md` + `IMPLEMENTATION.md`
**Purpose:** Atomic, dependency-ordered task list. Each task is sized
to complete in one focused work session (≈ 30 min – 4 h).

**Conventions:**
- ID format: `T-NNN`.
- `Deps:` — task IDs that must complete before this one starts.
- `Files:` — paths created or modified.
- `AC:` — acceptance criteria (binary: pass/fail).
- `Size:` `XS` (< 30 min), `S` (30–90 min), `M` (1.5–4 h), `L` (half day+).

**Phases:**
- **P1** Workspace + Tooling (T-001 → T-015)
- **P2** Kernel Primitives (T-016 → T-030)
- **P3** Type System (T-031 → T-040)
- **P4** Default Services I (T-041 → T-060)
- **P5** Core Agent (T-061 → T-080)
- **P6** Providers (T-081 → T-100)
- **P7** Tools (T-101 → T-130)
- **P8** Default Services II (T-131 → T-150)
- **P9** CLI Layer (T-151 → T-180)
- **P10** MCP Integration (T-181 → T-195)
- **P11** Plugin Loader (T-196 → T-205)
- **P12** Subcommands (T-206 → T-225)
- **P13** Testing Polish (T-226 → T-240)
- **P14** Documentation (T-241 → T-250)
- **P15** Release Prep (T-251 → T-260)

---

## P1 — Workspace + Tooling

### T-001 — Initialize monorepo
- **Deps:** none
- **Files:** `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `LICENSE` (Apache-2.0)
- **AC:** `pnpm install` runs with zero packages; root `package.json` defines workspace
- **Size:** XS

### T-002 — Configure TypeScript base
- **Deps:** T-001
- **Files:** `tsconfig.base.json`
- **AC:** Strict mode, `noUncheckedIndexedAccess`, target ES2023, module NodeNext
- **Size:** XS

### T-003 — Configure Biome
- **Deps:** T-001
- **Files:** `biome.json`
- **AC:** Format on save, lint rules tuned (no `any` as error, exhaustive deps, etc.)
- **Size:** XS

### T-004 — Set up Vitest workspace
- **Deps:** T-001
- **Files:** `vitest.config.ts`, `vitest.workspace.ts`
- **AC:** `pnpm test` runs zero tests successfully across workspace
- **Size:** XS

### T-005 — Create `@wrongstack/core` package skeleton
- **Deps:** T-002
- **Files:** `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- **AC:** `pnpm -F @wrongstack/core build` succeeds (empty entry exports)
- **Size:** XS

### T-006 — Create `@wrongstack/providers` skeleton
- **Deps:** T-005
- **Files:** `packages/providers/{package.json,tsconfig.json,src/index.ts}`
- **AC:** Builds; depends on `@wrongstack/core` workspace
- **Size:** XS

### T-007 — Create `@wrongstack/tools` skeleton
- **Deps:** T-005
- **Files:** `packages/tools/{package.json,tsconfig.json,src/index.ts}`
- **AC:** Builds
- **Size:** XS

### T-008 — Create `@wrongstack/mcp` skeleton
- **Deps:** T-005
- **Files:** `packages/mcp/{package.json,tsconfig.json,src/index.ts}`
- **AC:** Builds
- **Size:** XS

### T-009 — Create `@wrongstack/cli` skeleton
- **Deps:** T-005
- **Files:** `packages/cli/{package.json,tsconfig.json,src/index.ts}`
- **AC:** Builds; has `bin` field stub
- **Size:** XS

### T-010 — Create meta `wrongstack` app
- **Deps:** T-009
- **Files:** `apps/wrongstack/{package.json,src/index.ts}`
- **AC:** `bin: { wrongstack, wstack }` defined; `pnpm -F wrongstack build` works
- **Size:** XS

### T-011 — tsup config per package
- **Deps:** T-005..T-010
- **Files:** `packages/*/tsup.config.ts`
- **AC:** ESM output; type declarations emitted; sourcemaps on
- **Size:** S

### T-012 — Root scripts
- **Deps:** T-011
- **Files:** root `package.json` scripts
- **AC:** `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck` all defined and pass
- **Size:** XS

### T-013 — Initial CI workflow
- **Deps:** T-012
- **Files:** `.github/workflows/ci.yml`
- **AC:** Runs on PR; lint + typecheck + test matrix (Node 22, Ubuntu + macOS + Windows)
- **Size:** S

### T-014 — Editor config
- **Deps:** T-001
- **Files:** `.editorconfig`, `.vscode/settings.json`
- **AC:** UTF-8, LF, 2-space indent, Biome as formatter
- **Size:** XS

### T-015 — Changesets setup
- **Deps:** T-012
- **Files:** `.changeset/config.json`
- **AC:** `pnpm changeset` works; configured for independent versioning
- **Size:** XS

---

## P2 — Kernel Primitives

### T-016 — `kernel/tokens.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/kernel/tokens.ts`
- **AC:** All 15 service tokens defined with `Token<T>` type hints (forward types)
- **Size:** XS

### T-017 — `kernel/container.ts` — types
- **Deps:** T-016
- **Files:** `packages/core/src/kernel/container.ts`
- **AC:** `Token<T>`, `Factory<T>` type definitions
- **Size:** XS

### T-018 — `kernel/container.ts` — `bind` + `resolve`
- **Deps:** T-017
- **Files:** same
- **AC:** Basic bind/resolve works; double-bind throws; unbound resolve throws
- **Size:** S

### T-019 — `kernel/container.ts` — `override`
- **Deps:** T-018
- **Files:** same
- **AC:** Override replaces binding; throws if nothing to replace; clears cache
- **Size:** XS

### T-020 — `kernel/container.ts` — `decorate`
- **Deps:** T-019
- **Files:** same
- **AC:** Decorator wraps resolution; multiple decorators stack in registration order
- **Size:** S

### T-021 — Container tests
- **Deps:** T-020
- **Files:** `packages/core/tests/kernel/container.test.ts`
- **AC:** ≥ 95% line coverage; all edge cases tested
- **Size:** S

### T-022 — `kernel/pipeline.ts` — basic chain
- **Deps:** T-005
- **Files:** `packages/core/src/kernel/pipeline.ts`
- **AC:** `use`, `run` works; middleware chains with `next`
- **Size:** S

### T-023 — `kernel/pipeline.ts` — named middleware ops
- **Deps:** T-022
- **Files:** same
- **AC:** `insertBefore`, `insertAfter`, `replace`, `remove`, `prepend`, `list` work; duplicate name throws
- **Size:** S

### T-024 — Pipeline tests
- **Deps:** T-023
- **Files:** `packages/core/tests/kernel/pipeline.test.ts`
- **AC:** All primitives covered; exception propagation tested; async ordering verified
- **Size:** S

### T-025 — `kernel/events.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/kernel/events.ts`
- **AC:** `on`, `off`, `emit` typed via EventMap; subscriber exceptions isolated
- **Size:** XS

### T-026 — EventBus tests
- **Deps:** T-025
- **Files:** `packages/core/tests/kernel/events.test.ts`
- **AC:** Multi-subscriber, error isolation, unsubscribe verified
- **Size:** XS

### T-027 — Kernel index re-exports
- **Deps:** T-021, T-024, T-026
- **Files:** `packages/core/src/kernel/index.ts`
- **AC:** Public API of kernel exported cleanly
- **Size:** XS

### T-028 — Document kernel API (JSDoc)
- **Deps:** T-027
- **Files:** existing kernel files
- **AC:** Every public symbol has JSDoc with @example for non-obvious cases
- **Size:** S

### T-029 — Kernel performance baseline
- **Deps:** T-027
- **Files:** `packages/core/tests/perf/kernel.bench.ts`
- **AC:** Container resolve < 10 μs (singleton hit); pipeline 5-step run < 100 μs
- **Size:** S

### T-030 — Lock kernel line count
- **Deps:** T-027
- **Files:** `scripts/check-kernel-size.ts`
- **AC:** CI fails if kernel source exceeds 600 lines (excluding JSDoc); enforced
- **Size:** XS

---

## P3 — Type System

### T-031 — `types/blocks.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/types/blocks.ts`
- **AC:** All block types (text, tool_use, tool_result, image) defined with discriminator
- **Size:** XS

### T-032 — `types/messages.ts`
- **Deps:** T-031
- **Files:** `packages/core/src/types/messages.ts`
- **AC:** `Message` type with role + content; type narrowing helpers (`isTextBlock`, etc.)
- **Size:** XS

### T-033 — `types/tool.ts`
- **Deps:** T-032
- **Files:** `packages/core/src/types/tool.ts`
- **AC:** `Tool` interface, `ToolCallContext`, `ToolUseBlock`, `ToolResultBlock` types
- **Size:** XS

### T-034 — `types/provider.ts`
- **Deps:** T-032
- **Files:** `packages/core/src/types/provider.ts`
- **AC:** `Provider`, `Request`, `Response`, `Usage`, `Capabilities`, `StreamEvent`
- **Size:** S

### T-035 — `types/plugin.ts`
- **Deps:** T-033
- **Files:** `packages/core/src/types/plugin.ts`
- **AC:** `Plugin`, `PluginAPI` interfaces
- **Size:** XS

### T-036 — `types/config.ts`
- **Deps:** T-034
- **Files:** `packages/core/src/types/config.ts`
- **AC:** Full `Config` type with all sub-types (ContextConfig, ToolsConfig, etc.)
- **Size:** S

### T-037 — `types/permission.ts`
- **Deps:** T-033
- **Files:** `packages/core/src/types/permission.ts`
- **AC:** `Permission` type, `PermissionPolicy` interface, `TrustPolicy` schema
- **Size:** XS

### T-038 — `types/session.ts`
- **Deps:** T-032
- **Files:** `packages/core/src/types/session.ts`
- **AC:** `SessionEvent` discriminated union for all JSONL event types
- **Size:** XS

### T-039 — `types/index.ts` barrel
- **Deps:** T-031..T-038
- **Files:** `packages/core/src/types/index.ts`
- **AC:** All types re-exported
- **Size:** XS

### T-040 — Type narrowing helpers tests
- **Deps:** T-032, T-039
- **Files:** `packages/core/tests/types/narrowing.test.ts`
- **AC:** All type guards verified
- **Size:** XS

---

## P4 — Default Services I (foundation deps)

### T-041 — `utils/atomic-write.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/utils/atomic-write.ts`
- **AC:** Temp file + fsync + rename; preserves source file permissions; cleans up on error
- **Size:** S

### T-042 — `utils/atomic-write.ts` tests
- **Deps:** T-041
- **Files:** `packages/core/tests/utils/atomic-write.test.ts`
- **AC:** Verified on Linux + macOS + Windows (CI); crash midway leaves no orphan temp file
- **Size:** S

### T-043 — `utils/safe-json.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/utils/safe-json.ts`
- **AC:** Parse with size limit; stringify with error sanitization
- **Size:** XS

### T-044 — `utils/diff.ts` — Myers diff
- **Deps:** T-005
- **Files:** `packages/core/src/utils/diff.ts`
- **AC:** Produces unified diff format; matches `diff -u` output on test cases
- **Size:** M

### T-045 — `utils/diff.ts` tests
- **Deps:** T-044
- **Files:** `packages/core/tests/utils/diff.test.ts`
- **AC:** 20+ test cases including edge cases (empty, identical, total replacement)
- **Size:** S

### T-046 — `utils/glob-match.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/utils/glob-match.ts`
- **AC:** Supports `*`, `**`, `?`, character classes; matches `minimatch` behavior for trust patterns
- **Size:** S

### T-047 — `utils/newline-normalize.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/utils/newline-normalize.ts`
- **AC:** Detects file's predominant newline style; converts strings to match
- **Size:** XS

### T-048 — `defaults/logger.ts`
- **Deps:** T-031, T-041
- **Files:** `packages/core/src/defaults/logger.ts`
- **AC:** Level filtering, child loggers, JSON file + pretty stderr; respects `WRONGSTACK_LOG_LEVEL`
- **Size:** S

### T-049 — Logger tests
- **Deps:** T-048
- **Files:** `packages/core/tests/defaults/logger.test.ts`
- **AC:** Levels, child propagation, file rotation skipped (v1.0 simple)
- **Size:** S

### T-050 — `defaults/path-resolver.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/defaults/path-resolver.ts`
- **AC:** Resolves symlinks; detects project root (.git, package.json, go.mod); rejects out-of-sandbox
- **Size:** S

### T-051 — PathResolver tests
- **Deps:** T-050
- **Files:** `packages/core/tests/defaults/path-resolver.test.ts`
- **AC:** Symlink escape blocked; .. traversal blocked; project root detection verified
- **Size:** S

### T-052 — `defaults/secret-scrubber.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/defaults/secret-scrubber.ts`
- **AC:** 30+ regex patterns; `scrub(text)` returns redacted version with type marker
- **Size:** M

### T-053 — SecretScrubber tests
- **Deps:** T-052
- **Files:** `packages/core/tests/defaults/secret-scrubber.test.ts`
- **AC:** All patterns tested with positive + negative examples; no false positives on common dev strings
- **Size:** S

### T-054 — `defaults/token-counter.ts`
- **Deps:** T-034
- **Files:** `packages/core/src/defaults/token-counter.ts`
- **AC:** `TokenAccount` class accumulates Usage; cost estimate per pricing table
- **Size:** S

### T-055 — `defaults/retry-policy.ts`
- **Deps:** T-005
- **Files:** `packages/core/src/defaults/retry-policy.ts`
- **AC:** Default exp backoff + jitter; cap 30s; 429/529/5xx/network policies
- **Size:** S

### T-056 — RetryPolicy tests
- **Deps:** T-055
- **Files:** `packages/core/tests/defaults/retry-policy.test.ts`
- **AC:** Decision table verified; jitter range verified
- **Size:** S

### T-057 — `defaults/config-loader.ts`
- **Deps:** T-036, T-043
- **Files:** `packages/core/src/defaults/config-loader.ts`
- **AC:** Layered merge (6 layers); validation throws on schema violation with path
- **Size:** M

### T-058 — ConfigLoader tests
- **Deps:** T-057
- **Files:** `packages/core/tests/defaults/config-loader.test.ts`
- **AC:** Each layer override tested; env var mapping verified; CLI flag override verified
- **Size:** S

### T-059 — Color helper (`utils/color.ts`)
- **Deps:** T-005
- **Files:** `packages/core/src/utils/color.ts`
- **AC:** Single file, no deps; detects NO_COLOR env; basic ANSI for amber, red, green, cyan, dim
- **Size:** XS

### T-060 — Utilities barrel
- **Deps:** T-041..T-047, T-059
- **Files:** `packages/core/src/utils/index.ts`
- **AC:** Exports all utilities
- **Size:** XS

---

## P5 — Core Agent

### T-061 — `core/context.ts`
- **Deps:** T-039, T-054
- **Files:** `packages/core/src/core/context.ts`
- **AC:** Context class holds all per-session state; readonly view methods
- **Size:** S

### T-062 — Context tests
- **Deps:** T-061
- **Files:** `packages/core/tests/core/context.test.ts`
- **AC:** State mutations isolated; readonly views immutable
- **Size:** XS

### T-063 — `core/system-prompt-builder.ts` — Layer 1 constant
- **Deps:** T-005
- **Files:** `packages/core/src/core/system-prompt-builder.ts`
- **AC:** Layer 1 identity text (from SPEC §4.1) verbatim; exported as constant
- **Size:** XS

### T-064 — SystemPromptBuilder — Layer 2 generation
- **Deps:** T-063, T-033
- **Files:** same
- **AC:** Generates tool usage section from registered tools' `usageHint`
- **Size:** S

### T-065 — SystemPromptBuilder — Layer 3 env detection
- **Deps:** T-064, T-050
- **Files:** same
- **AC:** Detects OS, shell, Node version, git status (branch + modified count), languages
- **Size:** S

### T-066 — SystemPromptBuilder — Layer 4 memory + skills
- **Deps:** T-065
- **Files:** same (incomplete; expanded in T-131 + T-142)
- **AC:** Stub returns empty Layer 4; expanded when MemoryStore + SkillLoader exist
- **Size:** XS

### T-067 — SystemPromptBuilder tests
- **Deps:** T-066
- **Files:** `packages/core/tests/core/system-prompt-builder.test.ts`
- **AC:** Snapshot tests for each layer; token budget assertion < 4000 with default tools
- **Size:** S

### T-068 — `core/agent.ts` — class skeleton
- **Deps:** T-061, T-016
- **Files:** `packages/core/src/core/agent.ts`
- **AC:** Agent class constructor wires Container, Registries, Pipelines, EventBus
- **Size:** S

### T-069 — Agent — `run()` happy path
- **Deps:** T-068
- **Files:** same
- **AC:** Loop iterates; calls provider; handles end_turn; appends messages
- **Size:** M

### T-070 — Agent — tool execution dispatch
- **Deps:** T-069
- **Files:** same
- **AC:** Tool uses extracted; results appended; loop continues
- **Size:** M

### T-071 — Agent — execution strategies
- **Deps:** T-070
- **Files:** same
- **AC:** Parallel, sequential, smart strategies implemented; ordered output
- **Size:** S

### T-072 — Agent — AbortSignal handling
- **Deps:** T-071
- **Files:** same
- **AC:** Signal propagates to Provider and Tool; aborted state saves partial session
- **Size:** S

### T-073 — Agent — error recovery loop
- **Deps:** T-072
- **Files:** same
- **AC:** Provider errors routed to ErrorHandler; retryable ones retried; malformed tool_use recovered
- **Size:** M

### T-074 — Agent — max iterations
- **Deps:** T-073
- **Files:** same
- **AC:** Loop terminates after MAX_ITERATIONS; returns `status: 'max_iterations'`
- **Size:** XS

### T-075 — Agent — pipeline integration
- **Deps:** T-074
- **Files:** same
- **AC:** All 8 pipelines invoked in correct phases; default middleware registered
- **Size:** M

### T-076 — Agent — event emission
- **Deps:** T-075
- **Files:** same
- **AC:** All EventMap events emitted at correct lifecycle points
- **Size:** S

### T-077 — MockProvider test helper
- **Deps:** T-034
- **Files:** `packages/core/tests/helpers/mock-provider.ts`
- **AC:** Scriptable responses, abort simulation, retry simulation, usage accounting
- **Size:** S

### T-078 — Agent integration tests
- **Deps:** T-077, T-076
- **Files:** `packages/core/tests/core/agent.test.ts`
- **AC:** 15+ scenarios: simple chat, tool use, multi-iteration, abort, recovery, max iter
- **Size:** L

### T-079 — `defaults/error-handler.ts`
- **Deps:** T-055
- **Files:** `packages/core/src/defaults/error-handler.ts`
- **AC:** Implements error recovery taxonomy from SPEC §3.4
- **Size:** S

### T-080 — ErrorHandler tests
- **Deps:** T-079
- **Files:** `packages/core/tests/defaults/error-handler.test.ts`
- **AC:** All error classes routed correctly
- **Size:** S

---

## P6 — Providers

### T-081 — Tool format: `to-anthropic.ts`
- **Deps:** T-033
- **Files:** `packages/providers/src/tool-format/to-anthropic.ts`
- **AC:** Trivial mapping verified
- **Size:** XS

### T-082 — Tool format: `to-openai.ts`
- **Deps:** T-033
- **Files:** `packages/providers/src/tool-format/to-openai.ts`
- **AC:** Function wrapper format; assistant message with tool_calls; tool_results → tool role
- **Size:** M

### T-083 — Tool format: `from-openai.ts`
- **Deps:** T-082
- **Files:** `packages/providers/src/tool-format/from-openai.ts`
- **AC:** Parses tool_calls back to canonical tool_use blocks; sanitizes JSON; preserves IDs
- **Size:** M

### T-084 — Tool format tests
- **Deps:** T-083
- **Files:** `packages/providers/tests/tool-format.test.ts`
- **AC:** Round-trip identity tests; edge cases (multiple tool_results, mixed content)
- **Size:** S

### T-085 — `stop-reason.ts` normalization
- **Deps:** T-005
- **Files:** `packages/providers/src/stop-reason.ts`
- **AC:** Maps Anthropic + OpenAI + compatible variants to canonical enum
- **Size:** XS

### T-086 — `providers/anthropic.ts`
- **Deps:** T-081, T-085, T-034
- **Files:** `packages/providers/src/anthropic.ts`
- **AC:** Wraps `@anthropic-ai/sdk`; `complete()` works; abort signal propagated; usage extracted incl. cache stats
- **Size:** M

### T-087 — AnthropicProvider tests (mocked)
- **Deps:** T-086
- **Files:** `packages/providers/tests/anthropic.test.ts`
- **AC:** Tool use round-trip; cache control passed through; abort tested
- **Size:** S

### T-088 — `providers/openai.ts`
- **Deps:** T-082, T-083, T-085
- **Files:** `packages/providers/src/openai.ts`
- **AC:** Wraps `openai` SDK; cache_control stripped; tool_result message splitting works
- **Size:** M

### T-089 — OpenAIProvider tests (mocked)
- **Deps:** T-088
- **Files:** `packages/providers/tests/openai.test.ts`
- **AC:** Round-trip with multiple tool_results in one user message
- **Size:** S

### T-090 — `providers/openai-compatible.ts`
- **Deps:** T-088
- **Files:** `packages/providers/src/openai-compatible.ts`
- **AC:** Extends OpenAIProvider; accepts baseUrl, headers, quirks
- **Size:** S

### T-091 — Compatibility quirks implementation
- **Deps:** T-090
- **Files:** same
- **AC:** All 7 quirk flags from SPEC §5.3 implemented and observable
- **Size:** M

### T-092 — `providers/presets.ts`
- **Deps:** T-090
- **Files:** `packages/providers/src/presets.ts`
- **AC:** 10 preset profiles defined; consumed by config-loader
- **Size:** S

### T-093 — OpenAI-compatible tests
- **Deps:** T-091, T-092
- **Files:** `packages/providers/tests/openai-compatible.test.ts`
- **AC:** Each preset quirk verified with mocked HTTP
- **Size:** M

### T-094 — Provider registry
- **Deps:** T-005
- **Files:** `packages/core/src/registry/provider-registry.ts`
- **AC:** `register(type, factory)`, `create(config)`; built-in types registered
- **Size:** S

### T-095 — Provider registry tests
- **Deps:** T-094
- **Files:** `packages/core/tests/registry/provider-registry.test.ts`
- **AC:** Custom factory; unknown type throws
- **Size:** XS

### T-096 — Providers package barrel
- **Deps:** T-086, T-088, T-090, T-092
- **Files:** `packages/providers/src/index.ts`
- **AC:** All providers + presets exported
- **Size:** XS

### T-097 — Wire AnthropicProvider into Agent test path
- **Deps:** T-086, T-078
- **Files:** test fixtures
- **AC:** Agent end-to-end with real Anthropic (skipped in CI without key)
- **Size:** S

### T-098 — Provider pricing table
- **Deps:** T-054, T-096
- **Files:** `packages/providers/src/pricing.ts`
- **AC:** Per-model input/output/cache prices for Anthropic + OpenAI flagships
- **Size:** S

### T-099 — Capabilities lookup helper
- **Deps:** T-096
- **Files:** `packages/providers/src/capabilities.ts`
- **AC:** `capabilitiesFor(providerId, model)` returns Capabilities; supports model-specific overrides
- **Size:** S

### T-100 — Provider documentation
- **Deps:** T-099
- **Files:** `packages/providers/README.md`
- **AC:** Configuration examples for each preset; quirks documented
- **Size:** S

---

## P7 — Tools

### T-101 — `tools/read.ts`
- **Deps:** T-033, T-050
- **Files:** `packages/tools/src/read.ts`
- **AC:** Reads with offset/limit; line numbering; binary detection; size check
- **Size:** S

### T-102 — Read tests
- **Deps:** T-101
- **Files:** `packages/tools/tests/read.test.ts`
- **AC:** Binary rejection; offset/limit; large file; sandbox escape rejection; unicode
- **Size:** S

### T-103 — `tools/edit.ts` — match counting
- **Deps:** T-033, T-047, T-050
- **Files:** `packages/tools/src/edit.ts`
- **AC:** Single-match success; zero-match error with hint; multi-match error with line numbers
- **Size:** M

### T-104 — `tools/edit.ts` — atomic write
- **Deps:** T-103, T-041
- **Files:** same
- **AC:** Modifications applied atomically; preserves file permissions
- **Size:** S

### T-105 — `tools/edit.ts` — stale-read detection
- **Deps:** T-104
- **Files:** same
- **AC:** Errors if file modified externally between session-tracked read and edit
- **Size:** S

### T-106 — `tools/edit.ts` — newline normalization
- **Deps:** T-105, T-047
- **Files:** same
- **AC:** CRLF file with LF old_string still matches and writes back as CRLF
- **Size:** S

### T-107 — `tools/edit.ts` — replace_all
- **Deps:** T-106
- **Files:** same
- **AC:** All occurrences replaced; count returned
- **Size:** XS

### T-108 — `tools/edit.ts` — diff in result
- **Deps:** T-107, T-044
- **Files:** same
- **AC:** Returns unified diff alongside path + replacement count
- **Size:** S

### T-109 — Edit tests (extensive)
- **Deps:** T-108
- **Files:** `packages/tools/tests/edit.test.ts`
- **AC:** 25+ test cases covering all SPEC §6.2 edge cases
- **Size:** L

### T-110 — `tools/write.ts`
- **Deps:** T-033, T-041, T-050
- **Files:** `packages/tools/src/write.ts`
- **AC:** Read-before-write invariant; atomic write; returns created flag
- **Size:** S

### T-111 — Write tests
- **Deps:** T-110
- **Files:** `packages/tools/tests/write.test.ts`
- **AC:** Read-before-write blocks blind overwrites; new file creation works; sandbox respected
- **Size:** S

### T-112 — `tools/glob.ts`
- **Deps:** T-033, T-050
- **Files:** `packages/tools/src/glob.ts`
- **AC:** Patterns work; default ignore applied; .gitignore aware; sorted by mtime
- **Size:** S

### T-113 — Glob tests
- **Deps:** T-112
- **Files:** `packages/tools/tests/glob.test.ts`
- **AC:** Pattern types verified; ignore rules tested; sort order verified
- **Size:** S

### T-114 — `tools/grep.ts` — rg detection
- **Deps:** T-033, T-050
- **Files:** `packages/tools/src/grep.ts`
- **AC:** Detects `rg` in PATH; uses if available
- **Size:** S

### T-115 — `tools/grep.ts` — fallback impl
- **Deps:** T-114
- **Files:** same
- **AC:** In-process regex walker when rg unavailable; same output shape
- **Size:** M

### T-116 — `tools/grep.ts` — output modes
- **Deps:** T-115
- **Files:** same
- **AC:** content, files_with_matches, count modes all work
- **Size:** S

### T-117 — Grep tests
- **Deps:** T-116
- **Files:** `packages/tools/tests/grep.test.ts`
- **AC:** Both rg + fallback paths tested via env flag
- **Size:** S

### T-118 — `tools/bash.ts` — spawn + capture
- **Deps:** T-033
- **Files:** `packages/tools/src/bash.ts`
- **AC:** Spawns shell; captures stdout/stderr; respects timeout
- **Size:** S

### T-119 — `tools/bash.ts` — abort handling
- **Deps:** T-118
- **Files:** same
- **AC:** SIGTERM on abort; SIGKILL after grace period if still alive
- **Size:** S

### T-120 — `tools/bash.ts` — output sanitization
- **Deps:** T-119
- **Files:** same
- **AC:** ANSI stripped; CR normalized; truncated from middle if oversized
- **Size:** S

### T-121 — Bash tests
- **Deps:** T-120
- **Files:** `packages/tools/tests/bash.test.ts`
- **AC:** Timeout enforced; abort kills process; large output truncated correctly
- **Size:** S

### T-122 — `tools/fetch.ts` — HTTP basics
- **Deps:** T-033
- **Files:** `packages/tools/src/fetch.ts`
- **AC:** HTTPS-only by default; redirects handled; abort signal propagated
- **Size:** S

### T-123 — `tools/fetch.ts` — content processing
- **Deps:** T-122
- **Files:** same
- **AC:** HTML → markdown; JSON pretty-printed; binary rejected
- **Size:** M

### T-124 — `tools/fetch.ts` — SSRF protection
- **Deps:** T-123
- **Files:** same
- **AC:** Localhost + RFC1918 blocked by default; opt-out per env
- **Size:** S

### T-125 — Fetch tests
- **Deps:** T-124
- **Files:** `packages/tools/tests/fetch.test.ts`
- **AC:** With mock HTTP server; all content types tested; SSRF verified
- **Size:** M

### T-126 — `tools/todo.ts`
- **Deps:** T-033, T-061
- **Files:** `packages/tools/src/todo.ts`
- **AC:** Updates ctx.todos; renderer hook fires
- **Size:** XS

### T-127 — Todo tests
- **Deps:** T-126
- **Files:** `packages/tools/tests/todo.test.ts`
- **AC:** Replace semantics; in_progress invariant violation handled gracefully
- **Size:** XS

### T-128 — Tool registry
- **Deps:** T-033
- **Files:** `packages/core/src/registry/tool-registry.ts`
- **AC:** register, unregister, replace, get, list; duplicate register fails
- **Size:** S

### T-129 — Tool registry tests
- **Deps:** T-128
- **Files:** `packages/core/tests/registry/tool-registry.test.ts`
- **AC:** All operations + edge cases covered
- **Size:** S

### T-130 — Tools package barrel + usageHints
- **Deps:** T-101..T-127
- **Files:** `packages/tools/src/index.ts`
- **AC:** All tools exported with curated `usageHint` strings matching SPEC §6
- **Size:** S

---

## P8 — Default Services II (depend on Agent/Tools)

### T-131 — `defaults/memory-store.ts`
- **Deps:** T-039, T-050
- **Files:** `packages/core/src/defaults/memory-store.ts`
- **AC:** Reads 3 memory files; appends with timestamp; consolidation stub
- **Size:** S

### T-132 — `tools/memory.ts` — remember + forget
- **Deps:** T-131
- **Files:** `packages/tools/src/memory.ts`
- **AC:** Both tools work; forget requires confirm
- **Size:** S

### T-133 — Memory tests
- **Deps:** T-132
- **Files:** `packages/tools/tests/memory.test.ts`
- **AC:** Append, read, forget all verified; scope handling tested
- **Size:** S

### T-134 — Memory consolidation
- **Deps:** T-132, T-086
- **Files:** memory-store.ts
- **AC:** When memory.md > 8000 tokens, sub-LLM call deduplicates; old version backed up
- **Size:** M

### T-135 — `defaults/session-store.ts` — write path
- **Deps:** T-038, T-041
- **Files:** `packages/core/src/defaults/session-store.ts`
- **AC:** JSONL append; one session per file; unique ID generation
- **Size:** S

### T-136 — `defaults/session-store.ts` — load + replay
- **Deps:** T-135
- **Files:** same
- **AC:** Loads JSONL; reconstructs Context; rejects damaged sessions (orphan tool_use)
- **Size:** M

### T-137 — `defaults/session-store.ts` — list
- **Deps:** T-136
- **Files:** same
- **AC:** Returns SessionSummary[] with title, ts, model, token total
- **Size:** S

### T-138 — Session store tests
- **Deps:** T-137
- **Files:** `packages/core/tests/defaults/session-store.test.ts`
- **AC:** Write/load round-trip; orphan detection; concurrent session isolation
- **Size:** M

### T-139 — `defaults/compactor.ts` — Phase 1 elision
- **Deps:** T-061
- **Files:** `packages/core/src/defaults/compactor.ts`
- **AC:** Tool results outside preserve-K elided; pair invariant preserved
- **Size:** M

### T-140 — `defaults/compactor.ts` — Phase 2 summary
- **Deps:** T-139, T-086
- **Files:** same
- **AC:** Sub-LLM summary; turn boundary detection correct
- **Size:** M

### T-141 — Compactor tests
- **Deps:** T-140
- **Files:** `packages/core/tests/defaults/compactor.test.ts`
- **AC:** Synthetic conversations of various shapes; invariants verified; aggressive mode tested
- **Size:** M

### T-142 — `defaults/skill-loader.ts`
- **Deps:** T-005, T-050
- **Files:** `packages/core/src/defaults/skill-loader.ts`
- **AC:** 3-level discovery; YAML frontmatter parse; shadow by name; manifest output
- **Size:** S

### T-143 — Skill loader tests
- **Deps:** T-142
- **Files:** `packages/core/tests/defaults/skill-loader.test.ts`
- **AC:** Discovery, shadowing, malformed frontmatter handled
- **Size:** S

### T-144 — Default skills bundled
- **Deps:** T-142
- **Files:** `packages/core/skills/{typescript-strict,node-modern,react-modern,git-flow,prompt-engineering}/SKILL.md`
- **AC:** 5 skill files exist with valid frontmatter + content
- **Size:** M

### T-145 — `defaults/permission-policy.ts` — load trust.json
- **Deps:** T-037, T-043
- **Files:** `packages/core/src/defaults/permission-policy.ts`
- **AC:** Reads .wrongstack/trust.json; validates schema
- **Size:** S

### T-146 — PermissionPolicy — matching engine
- **Deps:** T-145, T-046
- **Files:** same
- **AC:** Pattern matching for bash commands, paths, URLs; deny > allow > default
- **Size:** S

### T-147 — PermissionPolicy — interactive prompt delegation
- **Deps:** T-146
- **Files:** same
- **AC:** Delegates to InputReader for prompt; result persisted to trust.json on "always allow"
- **Size:** S

### T-148 — PermissionPolicy tests
- **Deps:** T-147
- **Files:** `packages/core/tests/defaults/permission-policy.test.ts`
- **AC:** Precedence verified; persistence verified; deny absolute even with override
- **Size:** S

### T-149 — Wire Layer 4 in SystemPromptBuilder
- **Deps:** T-066, T-131, T-142
- **Files:** system-prompt-builder.ts
- **AC:** Real Layer 4 emits memory + skill manifest; cache_control marker applied
- **Size:** S

### T-150 — Default services smoke test
- **Deps:** T-149
- **Files:** `packages/core/tests/defaults/smoke.test.ts`
- **AC:** All 15 services can be resolved from Container with defaults bound
- **Size:** S

---

## P9 — CLI Layer

### T-151 — `cli/renderer.ts` — basic prose + headings
- **Deps:** T-059, T-009
- **Files:** `packages/cli/src/renderer.ts`
- **AC:** Markdown → terminal text with basic styling; respects NO_COLOR
- **Size:** S

### T-152 — Renderer — code block highlighting
- **Deps:** T-151
- **Files:** same
- **AC:** Fenced code blocks rendered with basic syntax coloring; language detected from fence
- **Size:** M

### T-153 — Renderer — tool call announcements
- **Deps:** T-152
- **Files:** same
- **AC:** "→ read src/auth.ts" style lines with consistent style
- **Size:** S

### T-154 — Renderer — diff display
- **Deps:** T-153, T-044
- **Files:** `packages/cli/src/diff-renderer.ts`
- **AC:** Unified diff with red/green coloring + line numbers
- **Size:** S

### T-155 — `cli/permission-prompt.ts`
- **Deps:** T-154
- **Files:** `packages/cli/src/permission-prompt.ts`
- **AC:** Shows diff for edit/write; single-keystroke (y/n/a/d/v); writes to trust.json on "a"
- **Size:** M

### T-156 — `cli/input-reader.ts` — readline wrapper
- **Deps:** T-009
- **Files:** `packages/cli/src/input-reader.ts`
- **AC:** Line + multi-line input; history persistence; tab completion stub
- **Size:** M

### T-157 — InputReader — slash command detection
- **Deps:** T-156
- **Files:** same
- **AC:** Lines starting with `/` route to slash dispatch; others go to agent
- **Size:** XS

### T-158 — Slash command registry
- **Deps:** T-005
- **Files:** `packages/core/src/registry/slash-command-registry.ts`
- **AC:** register, dispatch; built-in commands registered at boot
- **Size:** S

### T-159 — Slash command: `/help`
- **Deps:** T-158
- **Files:** `packages/cli/src/slash-commands/help.ts`
- **AC:** Lists all registered slash commands with one-line description
- **Size:** XS

### T-160 — Slash command: `/clear`
- **Deps:** T-158, T-061
- **Files:** `packages/cli/src/slash-commands/clear.ts`
- **AC:** Resets context; saves current session; starts new one
- **Size:** XS

### T-161 — Slash command: `/compact` + `/usage`
- **Deps:** T-141, T-054
- **Files:** `packages/cli/src/slash-commands/{compact,usage}.ts`
- **AC:** Compact runs default + aggressive; usage prints token + cost
- **Size:** S

### T-162 — Slash commands: `/use`, `/model`
- **Deps:** T-094
- **Files:** `packages/cli/src/slash-commands/{use,model}.ts`
- **AC:** Switches provider/model mid-session; persists current run state
- **Size:** S

### T-163 — Slash commands: `/tools`, `/skill`, `/save`, `/load`
- **Deps:** T-128, T-142, T-137
- **Files:** `packages/cli/src/slash-commands/{tools,skill,save,load}.ts`
- **AC:** Each shows relevant info or performs action
- **Size:** S

### T-164 — Slash command: `/exit` (+ aliases)
- **Deps:** T-158
- **Files:** `packages/cli/src/slash-commands/exit.ts`
- **AC:** Graceful save + exit; aliases `/quit`, `/q`
- **Size:** XS

### T-165 — `cli/repl.ts` — main loop
- **Deps:** T-157, T-068, T-151
- **Files:** `packages/cli/src/repl.ts`
- **AC:** Reads input, dispatches to agent or slash, renders output, loops
- **Size:** M

### T-166 — REPL — Ctrl+C / Ctrl+D handling
- **Deps:** T-165
- **Files:** same
- **AC:** First Ctrl+C cancels iteration; second exits; Ctrl+D graceful exit
- **Size:** S

### T-167 — REPL — multimodal paste detection
- **Deps:** T-165
- **Files:** input-reader.ts
- **AC:** Image paste from clipboard (where supported) attached as image block
- **Size:** M

### T-168 — `cli/index.ts` — CLI entry + argv parse
- **Deps:** T-165
- **Files:** `packages/cli/src/index.ts`
- **AC:** Parses argv; routes to subcommand or REPL; sets up signal handlers
- **Size:** M

### T-169 — CLI — single-shot mode
- **Deps:** T-168
- **Files:** same
- **AC:** `wstack "fix the bug"` runs agent once and exits with status code
- **Size:** S

### T-170 — CLI — global flags (--cwd, --provider, --model, --yolo, etc.)
- **Deps:** T-169, T-057
- **Files:** index.ts + config-loader.ts
- **AC:** All flags from SPEC §13.4 work; override config layer 6
- **Size:** S

### T-171 — Theme
- **Deps:** T-059
- **Files:** `packages/cli/src/theme.ts`
- **AC:** Amber primary, jarring pink accent, near-black background; auto-fallback on monochrome terms
- **Size:** S

### T-172 — Renderer tests
- **Deps:** T-154, T-171
- **Files:** `packages/cli/tests/renderer.test.ts`
- **AC:** Snapshot tests for markdown, code blocks, diffs, tool calls
- **Size:** S

### T-173 — Permission prompt tests
- **Deps:** T-155
- **Files:** `packages/cli/tests/permission-prompt.test.ts`
- **AC:** Single-keystroke handling verified; trust.json persistence verified
- **Size:** S

### T-174 — REPL integration tests
- **Deps:** T-166
- **Files:** `packages/cli/tests/repl.test.ts`
- **AC:** Scripted input → expected output; uses MockProvider
- **Size:** M

### T-175 — Tab completion
- **Deps:** T-156, T-158
- **Files:** input-reader.ts
- **AC:** Subcommands, slash commands, file paths completable
- **Size:** M

### T-176 — History persistence
- **Deps:** T-156
- **Files:** input-reader.ts
- **AC:** Saved to ~/.wrongstack/history; loaded on REPL start
- **Size:** XS

### T-177 — Renderer streaming hook stubs
- **Deps:** T-152
- **Files:** renderer.ts
- **AC:** API accepts StreamEvent shape; v1.0 receives whole response at once
- **Size:** XS

### T-178 — Exit code conventions
- **Deps:** T-168
- **Files:** index.ts
- **AC:** 0 success, 1 generic error, 2 config error, 130 SIGINT
- **Size:** XS

### T-179 — CLI smoke tests
- **Deps:** T-170
- **Files:** `packages/cli/tests/smoke.test.ts`
- **AC:** `wstack --help`, `wstack version`, `wstack config show` all run
- **Size:** S

### T-180 — Bin entry wiring
- **Deps:** T-010, T-178
- **Files:** `apps/wrongstack/src/index.ts`
- **AC:** `wrongstack` and `wstack` binaries both work after `pnpm build`
- **Size:** XS

---

## P10 — MCP Integration

### T-181 — `mcp/client.ts` — wrap SDK
- **Deps:** T-008
- **Files:** `packages/mcp/src/client.ts`
- **AC:** Wraps `@modelcontextprotocol/sdk` Client; supports 3 transports
- **Size:** M

### T-182 — MCP client — connection state machine
- **Deps:** T-181
- **Files:** same
- **AC:** States: connecting, connected, disconnected, reconnecting, failed
- **Size:** S

### T-183 — MCP client — reconnect logic
- **Deps:** T-182, T-055
- **Files:** same
- **AC:** 3 attempts with exp backoff; final fail marks server disabled
- **Size:** S

### T-184 — `mcp/wrap-tool.ts`
- **Deps:** T-128
- **Files:** `packages/mcp/src/wrap-tool.ts`
- **AC:** Wraps MCP tool as Tool; namespace prefix; mutation heuristic; output stringification
- **Size:** S

### T-185 — `mcp/registry.ts` — start/stop
- **Deps:** T-183, T-184
- **Files:** `packages/mcp/src/registry.ts`
- **AC:** Lifecycle methods; emits connect/disconnect events; unregisters tools on stop
- **Size:** S

### T-186 — MCP registry — boot integration
- **Deps:** T-185, T-168
- **Files:** cli/index.ts
- **AC:** Configured servers started during boot; startup timeout enforced
- **Size:** S

### T-187 — MCP registry — restart
- **Deps:** T-185
- **Files:** registry.ts
- **AC:** `restart(name)` stops + starts cleanly
- **Size:** XS

### T-188 — MockMCPServer test helper
- **Deps:** T-181
- **Files:** `packages/mcp/tests/helpers/mock-server.ts`
- **AC:** In-process stdio MCP server with scriptable tool list + responses
- **Size:** M

### T-189 — MCP integration tests
- **Deps:** T-188
- **Files:** `packages/mcp/tests/integration.test.ts`
- **AC:** Connect → list → call → disconnect; reconnect on drop; orphan call rejection
- **Size:** M

### T-190 — MCP — allowedTools filtering
- **Deps:** T-185
- **Files:** registry.ts
- **AC:** Only tools in allowedTools registered; missing names logged as warnings
- **Size:** XS

### T-191 — MCP — namespace collision prevention
- **Deps:** T-184
- **Files:** wrap-tool.ts
- **AC:** Built-in tool with same suffix not affected; mcp__ prefix always applied
- **Size:** XS

### T-192 — MCP error result handling
- **Deps:** T-184
- **Files:** wrap-tool.ts
- **AC:** isError responses converted to tool_result errors gracefully
- **Size:** XS

### T-193 — MCP — permission default
- **Deps:** T-184, T-147
- **Files:** wrap-tool.ts
- **AC:** All MCP tools default `confirm`; trust.json can override per pattern
- **Size:** XS

### T-194 — MCP package barrel
- **Deps:** T-185
- **Files:** `packages/mcp/src/index.ts`
- **AC:** Public API exported
- **Size:** XS

### T-195 — MCP documentation
- **Deps:** T-194
- **Files:** `packages/mcp/README.md`
- **AC:** Configuration examples; transport types; troubleshooting
- **Size:** S

---

## P11 — Plugin Loader

### T-196 — `plugin/api.ts`
- **Deps:** T-035, T-128, T-094
- **Files:** `packages/core/src/plugin/api.ts`
- **AC:** PluginAPI class providing container, pipelines, events, registries
- **Size:** S

### T-197 — `plugin/loader.ts` — module load
- **Deps:** T-196
- **Files:** `packages/core/src/plugin/loader.ts`
- **AC:** Loads plugin from string path or pre-imported object
- **Size:** S

### T-198 — Plugin loader — dependency graph
- **Deps:** T-197
- **Files:** same
- **AC:** Topological sort; cycle detection with specific error message
- **Size:** S

### T-199 — Plugin loader — apiVersion check
- **Deps:** T-198
- **Files:** same
- **AC:** SemVer range check against kernel's apiVersion; mismatch skip + error log
- **Size:** XS

### T-200 — Plugin loader — conflict check
- **Deps:** T-198
- **Files:** same
- **AC:** conflictsWith violations are loud-fail at boot
- **Size:** XS

### T-201 — Plugin loader — error isolation
- **Deps:** T-200
- **Files:** same
- **AC:** Plugin setup throwing doesn't crash agent; other plugins continue
- **Size:** S

### T-202 — Plugin loader tests
- **Deps:** T-201
- **Files:** `packages/core/tests/plugin/loader.test.ts`
- **AC:** All lifecycle paths tested with fixture plugins
- **Size:** M

### T-203 — Diagnostics tracking
- **Deps:** T-196
- **Files:** api.ts + container.ts
- **AC:** Each modification (override, decorate, pipeline.use) records owner plugin
- **Size:** S

### T-204 — Sample plugin: `@wrongstack/plug-noop`
- **Deps:** T-202
- **Files:** `packages/plug-noop/`
- **AC:** Reference plugin used in docs + tests; does nothing but registers; demonstrates API
- **Size:** XS

### T-205 — Plugin authoring docs
- **Deps:** T-204
- **Files:** `docs/plugins.md`
- **AC:** Complete tutorial: skeleton → first tool → first override → first pipeline mw
- **Size:** M

---

## P12 — Subcommands

### T-206 — `wstack init`
- **Deps:** T-168, T-057
- **Files:** `packages/cli/src/subcommands/init.ts`
- **AC:** Interactive setup: provider, key, model; writes ~/.wrongstack/config + .wrongstack/ in project
- **Size:** M

### T-207 — `wstack resume`
- **Deps:** T-136, T-168
- **Files:** `packages/cli/src/subcommands/resume.ts`
- **AC:** Resumes by ID or "most recent"; lists if no ID + multiple candidates
- **Size:** S

### T-208 — `wstack sessions`
- **Deps:** T-137
- **Files:** `packages/cli/src/subcommands/sessions.ts`
- **AC:** Lists last 20 with timestamp, title, model, token total
- **Size:** S

### T-209 — `wstack config show`
- **Deps:** T-057
- **Files:** `packages/cli/src/subcommands/config.ts` (subcmd handler)
- **AC:** Prints merged effective config; redacts API keys
- **Size:** XS

### T-210 — `wstack config edit`
- **Deps:** T-209
- **Files:** same
- **AC:** Opens primary config in $EDITOR; validates on save
- **Size:** XS

### T-211 — `wstack tools`
- **Deps:** T-128, T-203
- **Files:** `packages/cli/src/subcommands/tools.ts`
- **AC:** Lists tools with owner (built-in or plugin name); marks overridden ones
- **Size:** XS

### T-212 — `wstack skills`
- **Deps:** T-142
- **Files:** `packages/cli/src/subcommands/skills.ts`
- **AC:** Lists discovered skills with source layer + description
- **Size:** XS

### T-213 — `wstack providers`
- **Deps:** T-094
- **Files:** `packages/cli/src/subcommands/providers.ts`
- **AC:** Lists configured providers with connection status (ping)
- **Size:** S

### T-214 — `wstack mcp list`
- **Deps:** T-185
- **Files:** `packages/cli/src/subcommands/mcp.ts` — list handler
- **AC:** Lists MCP servers with state + tool counts
- **Size:** XS

### T-215 — `wstack mcp restart`
- **Deps:** T-187
- **Files:** same
- **AC:** Reconnects named server; reports new state
- **Size:** XS

### T-216 — `wstack plugin list`
- **Deps:** T-202, T-203
- **Files:** `packages/cli/src/subcommands/plugin.ts` — list handler
- **AC:** Shows loaded plugins with version + apiVersion
- **Size:** XS

### T-217 — `wstack plugin install`
- **Deps:** T-216
- **Files:** same
- **AC:** Runs npm install; appends to config.plugins; reloads
- **Size:** S

### T-218 — `wstack plugin remove` + `disable`
- **Deps:** T-217
- **Files:** same
- **AC:** Remove uninstalls + removes from config; disable sets enabled:false
- **Size:** S

### T-219 — `wstack diag`
- **Deps:** T-203
- **Files:** `packages/cli/src/subcommands/diag.ts`
- **AC:** Prints kernel version, apiVersion, full override map, pipeline contents, registries
- **Size:** M

### T-220 — `wstack usage`
- **Deps:** T-098, T-137
- **Files:** `packages/cli/src/subcommands/usage.ts`
- **AC:** Aggregates session token totals; computes cost; --since flag works
- **Size:** S

### T-221 — `wstack version`
- **Deps:** T-168
- **Files:** `packages/cli/src/subcommands/version.ts`
- **AC:** Prints version, apiVersion, git commit hash, build date
- **Size:** XS

### T-222 — `wstack help`
- **Deps:** T-168
- **Files:** `packages/cli/src/subcommands/help.ts`
- **AC:** Context-aware: bare = general; with subcmd = that subcmd's flags + examples
- **Size:** S

### T-223 — Subcommand router
- **Deps:** T-206..T-222
- **Files:** `packages/cli/src/index.ts`
- **AC:** Maps argv[0] to subcommand handler; unknown subcommand → error + suggest
- **Size:** S

### T-224 — Subcommand tests
- **Deps:** T-223
- **Files:** `packages/cli/tests/subcommands.test.ts`
- **AC:** Each subcommand smoke-tested for non-zero exit on bad input + zero on valid
- **Size:** M

### T-225 — Subcommand documentation
- **Deps:** T-224
- **Files:** README + docs
- **AC:** Each subcommand documented with example
- **Size:** S

---

## P13 — Testing Polish

### T-226 — End-to-end test: fresh install
- **Deps:** T-180
- **Files:** `e2e/tests/install.test.ts`
- **AC:** Fresh sandbox: install → init → single-shot task → exit 0
- **Size:** M

### T-227 — E2E: REPL flow
- **Deps:** T-226
- **Files:** `e2e/tests/repl.test.ts`
- **AC:** Scripted REPL session: input → tool call → output → slash command → exit
- **Size:** M

### T-228 — E2E: edit flow with permission
- **Deps:** T-227
- **Files:** `e2e/tests/edit.test.ts`
- **AC:** Mock project; agent edits file with confirm flow; trust persistence verified
- **Size:** M

### T-229 — E2E: MCP server real lifecycle
- **Deps:** T-188
- **Files:** `e2e/tests/mcp.test.ts`
- **AC:** Real `@modelcontextprotocol/server-filesystem` started + used + stopped
- **Size:** M

### T-230 — E2E: plugin install + use
- **Deps:** T-204
- **Files:** `e2e/tests/plugin.test.ts`
- **AC:** plug-noop installed via CLI; appears in diag; uninstalled cleanly
- **Size:** S

### T-231 — Coverage threshold enforcement
- **Deps:** T-013
- **Files:** vitest.config.ts + CI
- **AC:** CI fails if coverage < 90% on kernel/defaults; < 85% overall
- **Size:** S

### T-232 — Cross-platform CI
- **Deps:** T-013
- **Files:** ci.yml
- **AC:** Linux + macOS + Windows; all tests pass on all three
- **Size:** S

### T-233 — Performance baseline tests
- **Deps:** T-029
- **Files:** `packages/core/tests/perf/`
- **AC:** Boot time + kernel op times measured; fail CI on regression > 20%
- **Size:** S

### T-234 — Stress test: long session
- **Deps:** T-141
- **Files:** `e2e/tests/stress.test.ts`
- **AC:** 100-iteration session with periodic compaction; memory stable; no leaks
- **Size:** M

### T-235 — Stress test: many parallel tools
- **Deps:** T-071
- **Files:** stress.test.ts
- **AC:** 10 parallel tool calls per turn; ordering preserved; no race conditions
- **Size:** S

### T-236 — Fuzz: malformed provider response
- **Deps:** T-077, T-073
- **Files:** `packages/core/tests/fuzz/`
- **AC:** 1000 random malformed responses don't crash; all recovered gracefully
- **Size:** M

### T-237 — Fuzz: malformed config
- **Deps:** T-058
- **Files:** fuzz tests
- **AC:** Random invalid configs produce specific, actionable errors
- **Size:** S

### T-238 — Snapshot test: full system prompt
- **Deps:** T-067, T-149
- **Files:** snapshot tests
- **AC:** Default prompt output snapshotted; changes require approval
- **Size:** XS

### T-239 — Bundle size assertion
- **Deps:** T-011
- **Files:** scripts/check-bundle.ts
- **AC:** @wrongstack/core compressed < 200 KB; @wrongstack/cli < 400 KB
- **Size:** S

### T-240 — Linting full pass
- **Deps:** T-003
- **Files:** all source files
- **AC:** Zero biome warnings or errors across workspace
- **Size:** S

---

## P14 — Documentation

### T-241 — Root README
- **Deps:** T-180
- **Files:** `README.md`
- **AC:** TL;DR + install + 3 examples + comparison table + extending intro
- **Size:** M

### T-242 — llms.txt
- **Deps:** T-241
- **Files:** `llms.txt`
- **AC:** Under 2000 tokens; covers: install, minimal config, API surface, 5 scenarios
- **Size:** S

### T-243 — Architecture deep dive
- **Deps:** T-241
- **Files:** `docs/architecture.md`
- **AC:** Container/Pipeline/EventBus explained with diagrams + code examples
- **Size:** M

### T-244 — Provider authoring guide
- **Deps:** T-243
- **Files:** `docs/providers.md`
- **AC:** Step-by-step new provider; explains canonical format + conversion
- **Size:** M

### T-245 — Tool authoring guide
- **Deps:** T-243
- **Files:** `docs/tools.md`
- **AC:** Step-by-step new tool; schema + permission + edge cases
- **Size:** M

### T-246 — Skill writing guide
- **Deps:** T-244
- **Files:** `docs/skills.md`
- **AC:** Frontmatter format + activation + best practices for description quality
- **Size:** S

### T-247 — Configuration reference
- **Deps:** T-057
- **Files:** `docs/configuration.md`
- **AC:** Every config field documented with example + default
- **Size:** M

### T-248 — Troubleshooting
- **Deps:** T-247
- **Files:** `docs/troubleshooting.md`
- **AC:** Common errors with diagnosis steps; "wstack diag" usage pattern
- **Size:** S

### T-249 — Examples directory
- **Deps:** T-241
- **Files:** `examples/01-basic/ ... 06-real-world/`
- **AC:** 15+ working examples organized per LLM-native conventions
- **Size:** M

### T-250 — CHANGELOG seed
- **Deps:** T-015
- **Files:** `CHANGELOG.md`
- **AC:** v1.0.0 entry with highlights
- **Size:** XS

---

## P15 — Release Prep

### T-251 — Binary build script (Linux x64)
- **Deps:** T-180
- **Files:** `scripts/build-binary.ts`
- **AC:** `bun build --compile --target=bun-linux-x64`; produces single binary < 70 MB
- **Size:** S

### T-252 — Binary build: all platforms
- **Deps:** T-251
- **Files:** same
- **AC:** Linux x64+arm64, macOS x64+arm64, Windows x64 all built
- **Size:** S

### T-253 — Install script (curl one-liner)
- **Deps:** T-252
- **Files:** `scripts/install.sh`
- **AC:** Detects platform; downloads correct binary; installs to ~/.local/bin; symlinks
- **Size:** S

### T-254 — GitHub Release workflow
- **Deps:** T-252
- **Files:** `.github/workflows/release.yml`
- **AC:** On tag: build all binaries, publish npm packages, create GH release with artifacts
- **Size:** M

### T-255 — npm publish dry run
- **Deps:** T-254
- **Files:** scripts/publish.ts
- **AC:** Validates all packages publishable; checks for missing fields
- **Size:** S

### T-256 — Domain landing page
- **Deps:** T-241
- **Files:** `site/`
- **AC:** wrongstack.com renders hero + 3-column features + install command + footer
- **Size:** M

### T-257 — llms.txt deployed
- **Deps:** T-242, T-256
- **Files:** `site/public/llms.txt`
- **AC:** Accessible at wrongstack.com/llms.txt
- **Size:** XS

### T-258 — Smoke test against released artifact
- **Deps:** T-255
- **Files:** `e2e/release-smoke.test.ts`
- **AC:** Install from npm tarball in clean env; run init + single-shot; pass
- **Size:** S

### T-259 — Pre-release checklist
- **Deps:** T-258
- **Files:** `RELEASE.md`
- **AC:** Final checklist: version bump, changelog, tag, dry-run, publish, announce
- **Size:** XS

### T-260 — v1.0.0 release
- **Deps:** T-259
- **Files:** git tag
- **AC:** Tag pushed; release workflow green; npm packages live; binaries downloadable
- **Size:** S

---

## Summary

**Total tasks:** 260
**Phases:** 15
**Estimated effort:** 6–10 working weeks with focused AI-assisted execution.

### Critical path

T-001 → T-005 → T-017 → T-068 → T-086 → T-101 → T-165 → T-180 → T-260.

That spine alone (≈ 25 tasks) gets a working agent end-to-end with one
provider and the read tool. Everything else expands capability and
polish around that spine.

### Recommended execution order

1. Complete P1–P3 in one sitting (workspace, kernel, types — ~1 day).
2. Build a working slice: P4 partial + P5 partial + AnthropicProvider
   + read tool + minimal REPL (~3 days). This validates end-to-end.
3. Fill out the remaining tools (P7) one at a time, prioritizing edit.
4. Add session, memory, compactor (P8).
5. Polish CLI surface (P9, P12).
6. Layer in MCP (P10) and plugin loader (P11).
7. Testing + docs + release (P13–P15).

### What "done" looks like

When T-260 completes, a developer can:

```bash
$ npx wrongstack init
[interactive setup]

$ wstack "refactor auth.ts to use async/await"
[agent reads auth.ts, proposes changes, applies after confirm]

$ wstack resume
[continues last session]
```

…with full plugin system, MCP support, multi-provider switching, and
a clean override surface. That is v1.0.

---

**END OF TASKS**
