# WrongStack — Ideas & Improvement Report

**Generated:** 2026-06-09
**Baseline version:** 0.148.2
**Scope:** Full monorepo — 14 packages, ~110K SLOC source, 3091+ tests
**Sources:** Architecture docs, changelog, prior audits (May–June 2026), security reports, codebase scans, TODO/FIXME inventory

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [New Feature Ideas](#2-new-feature-ideas)
3. [Improvements to Existing Features](#3-improvements-to-existing-features)
4. [Architecture & Code Quality](#4-architecture--code-quality)
5. [Developer Experience](#5-developer-experience)
6. [Testing & Quality Assurance](#6-testing--quality-assurance)
7. [Security & Hardening](#7-security--hardening)
8. [Documentation & Community](#8-documentation--community)
9. [Quick-Win Checklist](#9-quick-win-checklist)
10. [Prioritization Matrix](#10-priorization-matrix)

---

## 1. Executive Summary

WrongStack is a mature, well-architected AI coding agent platform with:
- **14 packages** in a pnpm monorepo with strict layering
- **3,091+ tests** across all packages
- **0 open security vulnerabilities** (all 15 prior findings resolved)
- **47 agent roles** in the fleet roster
- **17 bundled skills** and **45+ slash commands**
- **4 execution surfaces**: CLI REPL, TUI (Ink/React), WebUI (Vite/React), ACP (editor integration)

The codebase is in excellent health. The items below are opportunities for growth, not remediation of problems. They're organized as **new feature ideas** (things that don't exist yet) and **improvements** (things that exist but could be better).

---

## 2. New Feature Ideas

### N-1: Agent Replay & Time-Travel Debugging

**What:** A `wstack replay <session-id>` command that reconstructs a past session step-by-step, allowing the user to step forward/backward through iterations, inspect the agent's state at each point, and even branch off from a historical decision point.

**Why:** Session JSONL files already capture every event. The `SessionReader` and `ReplayProviderRunner` exist in core. This would turn passive session logs into an interactive debugging experience — users could ask "why did the agent choose X at iteration 12?" and get a concrete answer.

**Building blocks that exist:**
- `packages/core/src/replay/` — replay-provider-runner and hash-based session lookup
- `packages/core/src/storage/session-reader.ts` — structured event replay
- `packages/core/src/storage/session-rewinder.ts` — snapshot-based state rewind
- `SessionEvent` JSONL format — full event-level audit trail

**Estimated effort:** 5–7 days for a working CLI/TUI replay mode.

---

### N-2: Collaborative Sessions (Multi-User)

**What:** Allow multiple users to connect to the same WrongStack session simultaneously via the WebUI, with real-time awareness of each other's actions (like Google Docs for coding agents).

**Why:** Teams frequently need to pair-program with AI assistance. Currently only one user drives the REPL at a time. The WebUI already has WebSocket infrastructure, auth tokens, and event streaming.

**Building blocks that exist:**
- WebUI WebSocket backend with typed message routing
- `EventBus` pub/sub with ~50 event types
- Per-session state isolation
- Cookie-based auth with `HttpOnly; SameSite=Strict`

**What's needed:**
- User identity layer (display names, cursor positions)
- Conflict resolution for simultaneous edits
- Operational transform or CRDT for shared state
- Permission scoping (who can approve tool calls)

**Estimated effort:** 10–15 days for MVP (2 users, same session).

---

### N-3: Agent Skill Marketplace / Registry

**What:** A public registry where community members can publish WrongStack skills (SKILL.md files), similar to npm but for AI agent behaviors. Users would `wstack skill install @user/skill-name` to pull skills from GitHub repos.

**Why:** The skill system (`packages/core/skills/`) already supports three scopes (project, user-global, bundled). Skills are just Markdown + YAML frontmatter — lightweight and easy to create. A marketplace would grow the ecosystem.

**Building blocks that exist:**
- `DefaultSkillLoader` with priority-based loading
- `SkillInstaller`, `ManifestStore`, `GitHubFetcher` in core
- `/skill-install`, `/skill-update`, `/skill-uninstall` slash commands
- `/skill-gen` for LLM-guided skill authoring

**What's needed:**
- A curated index (JSON manifest on a static site or GitHub repo)
- Quality scoring (test coverage, downloads, reviews)
- Skill validation CI pipeline
- Skill template generator (already scaffolded in `skill-creator`)

**Estimated effort:** 5–7 days for a GitHub-backed MVP (index repo + install from URL).

---

### N-4: Context-Aware Auto-Compaction Preview

**What:** Before the compactor runs, show the user a preview of what will be kept vs. collapsed, and let them pin specific exchanges as "do not compact." A `/compact preview` command that renders the compaction plan before executing it.

**Why:** Compaction is currently invisible. Users sometimes lose important context without understanding why. A preview mode would build trust and give users control.

**Building blocks that exist:**
- Three compaction strategies: `hybrid` (lossless), `intelligent` (LLM), `selective` (LLM keep/collapse)
- `AutoCompactionMiddleware` fires automatically on token thresholds
- Session events record compaction decisions

**What's needed:**
- A "compaction plan" output format (what's kept, what's summarized, what's dropped)
- Pinning mechanism (per-message flag or annotation)
- TUI/WebUI rendering of the compaction plan

**Estimated effort:** 3–5 days.

---

### N-5: Semantic Code Search via Embeddings

**What:** Augment the existing codebase index (`codebase-index`, `codebase-search`) with vector embeddings for semantic search. Instead of BM25 keyword matching, users could search for "where does authentication happen" and get relevant results even if the code says `verifyIdentity`.

**Why:** BM25 is fast but keyword-limited. Semantic search would dramatically improve codebase understanding for large or unfamiliar codebases.

**Building blocks that exist:**
- SQLite-based symbol index in `packages/tools/src/codebase-index/`
- `codebase-search` tool with BM25 ranking
- `codebase-stats` for index health monitoring
- Provider infrastructure (could use OpenAI embeddings or local model)

**What's needed:**
- Embedding generation pipeline (batch on index, incremental on change)
- Vector storage layer (SQLite with vector extension, or separate store)
- Hybrid search (BM25 + embedding similarity fusion)
- Configurable embedding provider

**Estimated effort:** 7–10 days for a working prototype.

---

### N-6: Goal Progress Dashboard (TUI & WebUI)

**What:** A rich, persistent dashboard that tracks autonomous goal progress over time — showing phase completion, task graphs, cost trends, and iteration velocity. The F9 goal panel in the TUI is a start; this would be a full-screen experience.

**Why:** Autonomous mode (`/goal`, `/autonomy`, `/autophase`) runs for hours. Users need visibility into what's happening without scrolling through thousands of lines of chat history.

**Building blocks that exist:**
- Goal store (`~/.wrongstack/projects/<hash>/goal.json`)
- AutoPhase planner with phase dependencies and checkpoints
- FleetBus for real-time subagent events
- Prometheus metrics and OTLP traces

**What's needed:**
- Phase graph visualization (could use Mermaid rendering)
- Cost/velocity trend charts (WebUI with chart library)
- Goal history and comparison across sessions
- Export goal report (markdown, HTML)

**Estimated effort:** 5–7 days for TUI full-screen + WebUI dashboard tab.

---

### N-7: Built-in Benchmarking Suite

**What:** A `wstack bench` command that runs a standardized set of coding tasks against the current model configuration and reports quality metrics (edit accuracy, test pass rate, task completion time, token efficiency).

**Why:** Users currently have no objective way to compare models or configurations. "Is GPT-5 better than Claude 4 for refactoring?" is an empirical question.

**Building blocks that exist:**
- `vitest.bench.config.ts` — benchmark infrastructure already configured
- Session JSONL event logs — full execution traces
- Cost tracking per session
- `SessionAnalyzer` for extracting metrics from sessions

**What's needed:**
- Standardized task definitions (10–20 coding tasks of varying difficulty)
- Scoring rubric (correctness, speed, cost, context efficiency)
- Baseline scores for popular models
- CI integration for regression testing model performance

**Estimated effort:** 7–10 days for a working suite with 10 tasks.

---

### N-8: Plugin Hot-Reload

**What:** When a plugin's source files change on disk, automatically reload the plugin without restarting WrongStack. Combined with `--watch` mode for plugin development.

**Why:** Plugin development currently requires restarting WrongStack on every change. This creates a slow feedback loop, especially for complex plugins.

**Building blocks that exist:**
- `file-watcher` plugin in `@wrongstack/plugins` — already watches files
- Plugin loader with `teardown()` lifecycle — clean unloading
- `loadPlugins` / `unloadPlugins` in core

**What's needed:**
- File watcher on plugin directories
- Debounced reload trigger
- State migration between plugin versions
- Error boundary (failed reload shouldn't crash the session)

**Estimated effort:** 3–4 days.

---

### N-9: Smart Context Budgeting

**What:** Instead of a single context-window compaction threshold, allocate a "context budget" per category (tools, conversation, memory, system prompt) and dynamically adjust allocations based on task phase. E.g., during planning, give more budget to conversation; during execution, give more to tool output.

**Why:** Current compaction is reactive (fire when threshold crossed). Proactive budget management would use the context window more efficiently and reduce information loss.

**Building blocks that exist:**
- `HybridCompactor` with lossless and lossy strategies
- Context modes (`balanced`, `frugal`, `deep`, `archival`)
- AutoPhase system with phase awareness
- Token estimation per message

**What's needed:**
- Budget allocator with configurable category weights
- Phase-aware budget profiles (planning vs. execution vs. review)
- Telemetry on budget utilization per category
- User-facing budget visualization

**Estimated effort:** 5–7 days for a working allocator.

---

### N-10: WrongStack as an MCP Server (Enhanced)

**What:** Expand the existing `wstack mcp serve` mode to expose not just tools but also the full agent lifecycle (session creation, multi-turn conversations, fleet management) as MCP resources and prompts. This would let any MCP-compatible editor (VS Code, Zed, Cursor) use WrongStack as a first-class coding agent backend.

**Why:** The MCP server mode currently exposes tools in read-only mode. Full agent lifecycle exposure would make WrongStack a drop-in backend for any MCP-compatible tool.

**Building blocks that exist:**
- `MCPServer` + `serveStdio` in `packages/mcp/src/server.ts`
- Tool registry with namespace prefixes
- Permission policy with read-only and YOLO modes

**What's needed:**
- MCP resources for session state, memory, plans
- MCP prompts for common workflows (refactor, debug, review)
- Streaming support via MCP transport
- Configuration for which tools/resources to expose

**Estimated effort:** 5–7 days for a working enhanced server.

---

## 3. Improvements to Existing Features

### E-1: Complete the 7 Unimplemented Slash Commands

**What:** The docs reference 7 slash commands (`/git`, `/health`, `/metrics`, `/plan`, `/security`, `/skill-gen`, `/skills`) with `docs/slash/*.md` files but no `buildXxxCommand` registered. Implement or remove the orphan docs.

**Why:** Orphan documentation creates confusion. Users try commands that don't work. The AGENTS.md explicitly calls this out as "H13 in the 2026-06-03 audit."

**Status:** Some are partially implemented as plugin commands (`/metrics`, `/health`, `/security`, `/skill-gen`, `/plan`) but not registered as core slash commands.

**Fix:**
1. Audit which commands exist as plugin commands vs. core commands
2. Update `docs/slash/README.md` to reflect actual registration status
3. Remove docs for commands that won't be implemented
4. Register remaining commands

**Estimated effort:** 1–2 days.

---

### E-2: WebUI Test Coverage (Currently 0%)

**What:** The `@wrongstack/webui` package has **0% test coverage**. The server handles WebSocket routing, API endpoints, file serving, authentication, and SSE streaming — all untested.

**Why:** The WebUI server is ~2,000 lines of HTTP/WS handling. Any refactoring is high-risk without tests. The planned file splits in the refactoring roadmap make tests a prerequisite.

**Fix:** Start with API endpoint tests:
1. Config API (get/set/providers)
2. Session API (list/get/resume/delete)
3. Auth flow (token generation, cookie, validation)
4. SSE streaming
5. File serving (path traversal guards, Range header)

**Estimated effort:** 5–7 days to reach 50% coverage.

---

### E-3: CLI Test Coverage (Currently 21%)

**What:** `@wrongstack/cli` is at 21% coverage despite being the main entry point. Critical paths like boot, wiring, subcommand dispatch, and REPL are undertested.

**Why:** The CLI is the most user-facing package. Regressions here directly impact users.

**Fix:** Prioritize:
1. Boot flow (argument parsing, config loading)
2. Subcommand dispatch (all 15+ subcommands)
3. REPL lifecycle (start, command, exit)
4. Error recovery paths
5. Session creation/resume

**Estimated effort:** 5–7 days to reach 50% coverage.

---

### E-4: Resolve the `expectDefined` Duplication (80 Copies)

**What:** The helper `expectDefined<T>()` is defined locally in **80 files** across 11 packages, despite a canonical implementation at `packages/core/src/utils/expect-defined.ts`.

**Why:** Every copy is a maintenance hazard. If the error message or behavior changes, 80 files need updating.

**Fix:**
1. Replace all local definitions with `import { expectDefined } from '@wrongstack/core'`
2. Add an explicit re-export in the core barrel
3. Add a unit test for the canonical implementation
4. Add an optional `label` parameter for better error messages
5. Add an ESLint/Biome rule to prevent local re-definitions

**Estimated effort:** 1–2 days (mostly automated).

---

### E-5: Translate Turkish Comments in Autophase Package

**What:** 8 files in `packages/core/src/autophase/` contain 146+ Turkish-language comments mixed with English.

**Why:** WrongStack is an international open-source project. Mixed-language comments create barriers for non-Turkish-speaking contributors.

**Fix:** Translate all Turkish comments to English. Can be done mechanically with AI assistance.

**Estimated effort:** 0.5–1 day.

---

### E-6: Complete the ACP Agent Implementation

**What:** The ACP agent (`packages/acp/src/agent/wrongstack-acp-agent.ts`) has a stubbed `/* TODO: load WrongStack Context */ {}`. The integration with editors (Zed, JetBrains, VS Code) is incomplete.

**Why:** ACP is the pathway to first-class editor integration. The protocol handler and transport layer exist but the agent itself isn't functional.

**Fix:**
1. Implement the WrongStack Context loading
2. Wire the ACP agent to the core Agent/Context/ToolExecutor pipeline
3. Test with at least one editor (VS Code via ACP extension)
4. Document the setup process

**Estimated effort:** 3–5 days.

---

### E-7: Enhanced Director Dashboard (WebUI)

**What:** The WebUI currently has no dedicated fleet/director visualization. The TUI has Ctrl+F (fleet monitor) and Ctrl+G (agents monitor). The WebUI needs equivalent functionality.

**Why:** Director mode is a flagship feature. Users running multi-agent workflows need real-time visibility into subagent status, task progress, budget usage, and fleet events.

**Building blocks that exist:**
- FleetBus event streaming (subagent events over WebSocket)
- Fleet store in `packages/webui/src/stores/`
- TUI fleet-monitor and fleet-panel as design references

**What's needed:**
- Fleet dashboard component (status table, health indicators, usage charts)
- Real-time event timeline
- Per-subagent detail view with transcript access
- Budget pressure visualization

**Estimated effort:** 5–7 days.

---

### E-8: Better Error Messages for Tool Failures

**What:** Tool execution errors are sometimes cryptic. The `EDITING.md` doc exists specifically because the `edit` tool fails silently with "arguments that were not a valid JSON object" — the real issue is payload size/encoding limits in streaming.

**Why:** Poor error messages waste user and agent time. The agent retries with the same approach, burning tokens.

**Fix:**
1. Add actionable error messages for common failure modes:
   - Edit tool: "Content too large for edit. Use `write` instead for files >2KB."
   - Bash tool: "Command timed out after Xs. Use AbortSignal.timeout() for longer commands."
   - Read tool: "File not found: <path>. Did you mean <suggestion>?"
2. Include recovery suggestions in tool error responses
3. Make the error messages model-actionable (the LLM should know what to do differently)

**Estimated effort:** 2–3 days.

---

### E-9: Smarter Tool Execution Strategy

**What:** The `ToolExecutor` has three strategies: `parallel`, `sequential`, and `smart`. The "smart" strategy currently distinguishes mutating vs. non-mutating. It could be enhanced with:
- Dependency awareness (tool B needs tool A's output)
- Resource awareness (don't run 10 file reads simultaneously if the OS limits FDs)
- Priority ordering (urgent tools first)

**Why:** Smarter tool batching would reduce iteration count and improve reliability on resource-constrained systems.

**Estimated effort:** 3–5 days for dependency awareness.

---

### E-10: Session Export to More Formats

**What:** Currently supports markdown, JSON, and text export. Add:
- HTML export with syntax highlighting
- PDF export (via headless browser or library)
- JUnit XML (for CI integration of test-related sessions)
- ChatGPT conversation format (for sharing with other AI tools)

**Why:** Users want to share sessions in different contexts — in PRs, in documentation, with other AI tools, or as permanent records.

**Estimated effort:** 2–3 days per format.

---

## 4. Architecture & Code Quality

### A-1: File Size Decomposition (14 Files >1000 Lines)

**What:** The refactoring plan identifies 14 files over 1,000 lines, with the largest (`tui/src/app.tsx`) at 6,408 lines. The plan in `docs/notes/refactor-2026-06-05.md` is comprehensive but not yet executed.

**Priority files:**
| File | Lines | Risk |
|------|-------|------|
| `tui/src/app.tsx` | 6,408 | High |
| `webui/src/server/index.ts` | 1,961 | Medium-High |
| `cli/src/slash-commands/sdd.ts` | 1,809 | Medium |
| `cli/src/index.ts` | 1,786 | High |
| `core/src/coordination/director.ts` | 1,743 | Medium |
| `tui/src/components/history.tsx` | 1,632 | Medium |

**Why:** Large files are hard to review, test, and maintain. They also make merge conflicts more likely in team environments.

**Recommended approach:** Follow the phased plan in the refactoring doc. Phase 1 (Big Three) is highest priority.

**Estimated effort:** 11–13 days total (as estimated in the existing plan).

---

### A-2: Typed Plugin Config Accessor

**What:** Plugins currently access their config through unsafe casts like `(api.config.extensions?.['cost-tracker'] as Record<string, unknown>)?.['budgetLimit'] as number`. Add a typed accessor to the PluginAPI.

**Why:** The plugin already declares `configSchema` and `defaultConfig`. The API should expose typed config without requiring `as` casts that bypass type checking.

**Fix:**
```typescript
// Add to PluginAPI
getPluginConfig<T extends PluginConfig>(): T;
```

**Estimated effort:** 1–2 days.

---

### A-3: Event Map Consistency Check

**What:** The EventBus has ~50 typed events. The `cost-tracker` plugin uses `'session.close' as any` because the event doesn't exist in the typed map. Add a build-time or test-time check that all event names used in `api.onEvent()` calls exist in `EventMap`.

**Why:** `as any` event subscriptions bypass the type system and silently break when event names change.

**Fix:**
1. Add `'session.close'` to EventMap if it's legitimate, or use `session.ended`
2. Add a lint rule or test that greps for `as any` in event subscriptions

**Estimated effort:** 0.5–1 day.

---

### A-4: Remove `as any` from Source Code

**What:** The codebase analysis report says "zero `as any` in core source" but the cost-tracker plugin and some provider code still use it. Audit and eliminate remaining instances.

**Why:** The project's TypeScript strict mode policy explicitly forbids `as any`.

**Estimated effort:** 1–2 days.

---

### A-5: Architecture Boundary Test Coverage

**What:** 12 boundary tests exist in `packages/core/tests/architecture/package-boundaries.test.ts`. Consider adding:
- Cross-package import checks for ALL packages (not just core)
- Runtime dependency cycle detection across the full monorepo
- Barrel export completeness checks

**Why:** The current tests only cover `@wrongstack/core`'s internal layering. Other packages could develop circular dependencies.

**Estimated effort:** 1–2 days.

---

## 5. Developer Experience

### D-1: `wstack doctor` Command

**What:** A comprehensive health check command that validates:
- Configuration validity and completeness
- API key presence and validity (test call)
- MCP server connectivity
- Plugin compatibility with current kernel version
- File system permissions
- PATH availability (pnpm, node, git)
- Session storage health (corrupted JSONL files)

**Why:** Users currently troubleshoot by reading error messages and searching docs. A single diagnostic command would solve most "it doesn't work" problems.

**Building blocks that exist:**
- `wstack diag-doctor` subcommand (partially)
- Config validation
- MCP server health checks
- Health registry

**Estimated effort:** 2–3 days to make comprehensive.

---

### D-2: Interactive Onboarding Wizard

**What:** A `wstack init` command that guides new users through:
1. API key setup (provider selection, key entry)
2. Model selection (with cost/quality trade-offs explained)
3. Project configuration (AGENTS.md, skills, hooks)
4. MCP server setup (recommended servers for project type)
5. Permission mode selection (conservative, normal, YOLO)

**Why:** WrongStack has a lot of configuration surface area. New users are overwhelmed. A wizard would reduce time-to-first-success.

**Estimated effort:** 3–5 days.

---

### D-3: Better Windows Support

**What:** The test run failed with `'C:\\Program' is not recognized as an internal or external command` — a classic Windows PATH space issue. Audit and fix Windows-specific issues:
- PATH handling with spaces
- Shell command escaping (cmd.exe vs. PowerShell vs. bash)
- File path normalization
- Terminal color support
- Process signal handling (SIGINT, SIGTERM)

**Why:** Windows is a first-class platform but some tools and scripts assume Unix.

**Estimated effort:** 2–3 days for a thorough audit and fix pass.

---

### D-4: VS Code Extension

**What:** A VS Code extension that integrates WrongStack as an ACP agent, providing:
- Inline code suggestions from the agent
- Chat panel in the sidebar
- Tool call approval UI
- Session management

**Why:** Many developers prefer staying in their editor. The ACP infrastructure provides the protocol; the extension provides the surface.

**Estimated effort:** 10–15 days for a working extension.

---

### D-5: Configuration Migration Tooling

**What:** When breaking config changes happen, provide automatic migration:
- Detect old config format version
- Apply migration scripts
- Back up old config
- Report what changed

**Why:** Config format changes between versions can break existing setups silently.

**Building blocks that exist:**
- `ConfigMigration` in `packages/core/src/storage/`
- Config history with backup/restore

**Estimated effort:** 2–3 days.

---

## 6. Testing & Quality Assurance

### T-1: Integration Test Suite

**What:** A suite of end-to-end integration tests that exercise full workflows:
- Start agent → send prompt → receive response → verify file changes
- Multi-agent workflow: spawn → assign → await → verify results
- MCP server lifecycle: start → use tools → stop
- WebUI: start → connect WS → send message → verify response

**Why:** Unit tests verify individual components but not that they work together. The complex wiring in `packages/cli/src/index.ts` has minimal integration coverage.

**Estimated effort:** 7–10 days for a working CI-integrated suite.

---

### T-2: Property-Based Testing for Core Primitives

**What:** Add property-based tests (using `fast-check` or similar) for:
- Container DI: bind, resolve, override, decorate with arbitrary factories
- Pipeline: middleware ordering with arbitrary middleware counts
- EventBus: event delivery with arbitrary subscriber counts
- SessionWriter: JSONL serialization roundtrip with arbitrary events

**Why:** The kernel primitives are foundational. Property-based testing can find edge cases that hand-written tests miss.

**Estimated effort:** 3–5 days.

---

### T-3: Mutation Testing

**What:** Run a mutation testing tool (Stryker) on critical packages to measure test effectiveness.

**Why:** 3,091 tests sounds like a lot, but how many actually catch bugs? Mutation testing would reveal gaps.

**Estimated effort:** 2–3 days to set up and analyze results.

---

### T-4: Performance Regression Benchmarks

**What:** Establish performance baselines for:
- Agent iteration latency (prompt → response)
- Tool execution latency (per tool type)
- Compaction time vs. context size
- Session startup time
- Memory usage during long sessions

**Why:** WrongStack runs for hours. Performance regressions compound over time. Without baselines, regressions go undetected.

**Estimated effort:** 3–4 days to establish baselines.

---

## 7. Security & Hardening

### S-1: Complete Capability-Based Authorization Migration

**What:** The capability model is partially implemented. Complete migration by:
1. Adding capabilities to ALL remaining tools (long tail)
2. Making `DefaultPermissionPolicy` fully capability-aware
3. Adding capability enforcement for plugin tool mutations
4. Documenting capabilities in tool-author-guide

**Why:** The security hardening plan (P1) identified this as the primary architectural improvement. Name-based denylists are fragile; capabilities are auditable.

**Status:** Core tools done. Long tail + policy integration remaining.

**Estimated effort:** 3–5 days.

---

### S-2: Secret Rotation Helpers

**What:** Add a `wstack auth rotate` command that:
1. Generates a new encryption key
2. Re-encrypts all secrets in config with the new key
3. Verifies the new key works
4. Backs up the old key

**Why:** The current encryption key is per-machine and never rotated. If compromised, there's no recovery path.

**Estimated effort:** 1–2 days.

---

### S-3: MCP Server Sandboxing

**What:** Add sandboxing options for MCP servers:
- Filesystem access restrictions (only project directory)
- Network restrictions (block outbound except to specific hosts)
- Process spawning restrictions
- Resource limits (memory, CPU, time)

**Why:** MCP servers run arbitrary code. A compromised or misbehaving server could access files outside the project, make network calls, or consume resources.

**Estimated effort:** 5–7 days for a working sandbox (using OS-level mechanisms).

---

### S-4: Audit Log Integrity

**What:** Add tamper detection for session JSONL files:
- Hash chain (each event includes a hash of the previous event)
- Signed session footer on session close
- Verification tool (`wstack audit verify <session-id>`)

**Why:** Session logs are the audit trail for everything WrongStack does. If logs can be tampered with, the audit trail is unreliable.

**Estimated effort:** 2–3 days.

---

## 8. Documentation & Community

### C-1: Interactive API Documentation

**What:** Generate API documentation from TypeScript types using TypeDoc or similar. Host at `docs.wrongstack.dev/api`.

**Why:** Plugin and tool authors need to understand the public API surface. Currently they must read source code.

**Estimated effort:** 2–3 days for initial generation + CI integration.

---

### C-2: Architecture Decision Records (ADR) Expansion

**What:** The `docs/adr/` directory has only 1 ADR (layer-instead-of-split). Key decisions that should be documented:
- Why ULIDs instead of UUIDs
- Why JSONL for session storage
- Why 7-layer architecture in core
- Why capability-based authorization
- Why Cookie-based WS auth
- Why the skill Markdown format

**Why:** ADRs help new contributors understand the "why" behind architectural choices, preventing well-intentioned changes that violate established patterns.

**Estimated effort:** 1–2 days.

---

### C-3: Contributing Guide

**What:** A comprehensive `CONTRIBUTING.md` covering:
- Development setup (prerequisites, build, test, lint)
- Code style and conventions
- PR process (branching, review, merge)
- Security checklist for new tools/plugins/MCP
- How to add slash commands, tools, providers, plugins, skills
- Architecture overview with diagrams

**Why:** The project has excellent technical docs but no single onboarding document for contributors.

**Estimated effort:** 2–3 days.

---

### C-4: Video/Interactive Tutorials

**What:** Create guided tutorials for common workflows:
- "Your first WrongStack session"
- "Building a custom plugin"
- "Multi-agent debugging with /collab"
- "Spec-driven development with /sdd"
- "Autonomous mode with /goal"

**Why:** Text docs are great for reference. Tutorials are better for learning. The marketing site (`website/`) is the natural host.

**Estimated effort:** 3–5 days per tutorial.

---

### C-5: Changelog Automation

**What:** Automate changelog generation from conventional commits. Currently the changelog is hand-written (see the "consolidated release" notes in v0.148.0).

**Why:** The changelog is excellent but manually intensive. Automation would ensure no changes are missed.

**Building blocks that exist:**
- `semver_bump` and `semver_changelog` plugins in `@wrongstack/plugins`
- Conventional commit format used in practice
- Git integration

**Estimated effort:** 1–2 days to wire into release process.

---

## 9. Quick-Win Checklist

These items can be completed in **1 day or less** each:

| # | Item | Impact |
|---|------|--------|
| 1 | Translate Turkish comments in autophase (8 files) | Code quality |
| 2 | Add `'session.close'` to EventMap or remove `as any` workaround | Type safety |
| 3 | Set `mutating: true` on `cost_reset` tool | Permission correctness |
| 4 | Add explicit re-export of `expectDefined` in core barrel | Discoverability |
| 5 | Add unit test for canonical `expectDefined` | Test coverage |
| 6 | Remove orphan docs for unimplemented slash commands (or implement them) | Doc accuracy |
| 7 | Add ADRs for 5 key architectural decisions | Documentation |
| 8 | Add `wstack audit verify` for session JSONL hash checking | Security |
| 9 | Add security comment to `pnpm-workspace.yaml` explaining allowlists | Process |
| 10 | Fix Windows PATH space issue in test execution | Windows support |

---

## 10. Prioritization Matrix

### Impact vs. Effort

```
                    HIGH IMPACT
                        │
           E-2 WebUI   │  N-2 Collab
           Tests (0%)   │  Sessions
           E-3 CLI      │
           Tests (21%)  │
                        │
   E-4 expectDefined ───┼─── E-7 Director
   E-5 Turkish comments │    Dashboard
   A-3 Event map fix    │
                        │  N-1 Replay &
   D-1 Doctor cmd      │    Time-Travel
   D-5 Config migration│
                        │
   LOW EFFORT ──────────┼────────── HIGH EFFORT
                        │
   E-1 Slash commands   │  N-5 Semantic
   A-2 Plugin config    │    Search
   S-2 Secret rotation  │
                        │  D-4 VS Code
   E-8 Better errors    │    Extension
   E-10 Session export  │
                        │  N-7 Benchmark
   C-2 ADRs             │    Suite
   C-5 Changelog auto   │
                        │
                    LOW IMPACT
```

### Recommended Execution Order

1. **Quick wins** (1 day each) → build momentum, reduce tech debt
2. **E-2 + E-3** (test coverage) → prerequisite for safe refactoring
3. **A-1** (file decomposition) → follow the existing phased plan
4. **S-1** (capability migration) → complete the security hardening
5. **N-1** (replay/time-travel) → high-impact, leverages existing infrastructure
6. **E-7** (director dashboard) → flagship feature needs flagship visualization
7. **D-1 + D-2** (doctor + onboarding) → reduce support burden
8. **Remaining features** → prioritize based on user demand

---

---

## 11. Deep Scan — Additional Findings

These items come from a second-pass deep scan of plugins, tools internals, providers, SDD, autophase, worktree, ACP, website, and examples.

---

### 11.1 Plugin System Gaps

#### P-1: Plugin State Sharing Between `setup` and `teardown`

**What:** The cron and file-watcher plugins both use module-level state with explicit comments explaining why:

> *"The Plugin interface in @wrongstack/core does not currently thread state from `setup` → `teardown`. The previous implementation kept `state` as a `const` inside the setup closure, which made it inaccessible from teardown — so the teardown function fell through to a default and silently leaked every setTimeout timer."*

This is a **systemic issue** with the Plugin interface, not just these two plugins. Any plugin that manages resources (timers, file watchers, child processes, WebSocket connections) has the same problem.

**Fix:** Extend the Plugin interface to support state threading:

```typescript
interface Plugin {
  // ... existing fields ...
  setup(api: PluginAPI): Promise<PluginState>;
  teardown(state: PluginState): Promise<void>;
}
```

Or use a `Symbol`-keyed state bag on the PluginAPI:

```typescript
// In setup:
const state = api.setState('cron', { jobs: new Map(), timers: new Map() });
// In teardown:
const state = api.getState<CronState>('cron');
```

**Impact:** All 10 bundled plugins + any community plugins that manage resources.

**Estimated effort:** 1–2 days for the interface change + migration.

---

#### P-2: Plugin `auto-doc` Uses Regex Parsing Instead of AST

**What:** The `auto-doc` plugin (`packages/plugins/src/auto-doc/index.ts`) parses TypeScript source with regex to extract function signatures, classes, types, and interfaces:

```typescript
const reFunction = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)(?:\s*:\s*(.+?))\s*\{/;
const reArrowFn = /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\((.*?)\)\s*(?::\s*(.+?))\s*=>/;
```

**Why it matters:** Regex parsing of TypeScript is fragile. It misses:
- Generic parameters `<T extends Foo>`
- Destructured parameters `{ name, age }: Person`
- Default parameters `timeout = 5000`
- Overloaded signatures
- Methods inside classes
- Computed property names
- Type-only exports

The codebase already has a proper TypeScript parser in `packages/tools/src/codebase-index/ts-parser.ts`.

**Fix:** Either:
1. Use the existing `ts-parser.ts` from the codebase index
2. Use TypeScript's compiler API directly (`ts.createSourceFile`)
3. Use `ts-morph` for a higher-level API

**Estimated effort:** 2–3 days to rewrite with AST-based parsing.

---

#### P-3: No Plugin Discovery or Dependency Resolution

**What:** The plugin loader sorts by `dependsOn` and `optionalDeps`, but there's no way for users to discover available plugins or for plugins to declare compatibility with specific WrongStack versions beyond `apiVersion`.

**What's missing:**
- Plugin marketplace or registry (separate from the skill marketplace idea N-3)
- Plugin compatibility matrix (which versions work with which WrongStack versions)
- Plugin dependency resolution (if plugin A requires plugin B)
- Plugin health check endpoint (does this plugin still work?)

**Estimated effort:** 5–7 days for a basic discovery system.

---

### 11.2 Tools & Codebase Intelligence

#### T-5: Codebase Index Language Support Expansion

**What:** The codebase indexer (`packages/tools/src/codebase-index/`) supports TypeScript, Go, Python, Rust, JSON, and YAML. Notable missing languages:

| Language | Parser | Why it matters |
|----------|--------|----------------|
| **Java** | Missing | Enterprise codebases |
| **C/C++** | Missing | Systems programming |
| **C#** | Missing | .NET ecosystem |
| **Ruby** | Missing | Rails projects |
| **PHP** | Missing | WordPress/Laravel |
| **Swift** | Missing | iOS/macOS |
| **Kotlin** | Missing | Android/server |

**Building blocks:** The indexer has a clean parser interface — each language is a `parseSymbols(content, filePath)` function. Adding a new language is ~100–200 lines for a regex-based parser or more for an AST-based one.

**Estimated effort:** 1–3 days per language (regex-based), 3–5 days per language (AST-based).

---

#### T-6: Background Indexer Should Be Incremental

**What:** The `background-indexer.ts` exists but the indexer currently re-parses all files on each run. For large codebases (>10K files), full reindexing is slow.

**Fix:**
1. Track file hashes (MTimes are already tracked in `Context.fileMtimes`)
2. Only re-parse changed files
3. Persist the index database across sessions
4. Use `fs.watch` for real-time incremental updates

**Estimated effort:** 3–5 days.

---

#### T-7: Circuit Breaker — Only Used for Bash/Exec

**What:** The `CircuitBreaker` (`packages/tools/src/circuit-breaker.ts`) is a sophisticated tool with failure thresholds, slow-call detection, rate limiting, and auto-recovery. But it's only wired into the ProcessRegistry for bash/exec tools.

**Other tools that could benefit:**
- `fetch` — network calls can hang or fail repeatedly
- `test` — flaky tests cause false failure signals
- `grep` / `glob` — filesystem scans on large directories can be slow
- MCP tool wrappers — external MCP servers can be unreliable

**Fix:** Make the CircuitBreaker a generic middleware that any tool can opt into. Add a `circuitBreaker` option to the Tool interface.

**Estimated effort:** 2–3 days.

---

#### T-8: Tool Output Streaming Progress for All Tools

**What:** Only some tools implement `executeStream`. The `read`, `grep`, `glob`, and `tree` tools return their full output at once, which causes long waits for large results.

**Why it matters:** Large file reads or grep results can produce 10K+ lines. Streaming would let the agent start processing partial results immediately.

**Fix:** Add `executeStream` to:
- `read` — stream file contents line by line
- `grep` — stream matches as they're found
- `glob` — stream file paths as they're discovered
- `tree` — stream directory entries as they're walked

**Estimated effort:** 2–3 days per tool.

---

### 11.3 Autonomy & Goal System

#### A-6: Eternal Autonomy — No Persistent State Across Restarts

**What:** `EternalAutonomy` (`packages/core/src/execution/eternal-autonomy.ts`) is a 990-line sense-decide-execute-reflect loop. It journals decisions to `goal.json` but doesn't persist its internal state (current source rotation, failure counts, sleep schedule) across restarts.

**Why it matters:** If WrongStack crashes during eternal mode, it restarts from scratch — re-reading the goal but losing track of what it was doing, what was failing, and how long it had been running.

**Fix:** Persist a small state file (`eternal-state.json`) alongside `goal.json`:
```json
{
  "iteration": 47,
  "lastSource": "git",
  "consecutiveFailures": 0,
  "totalCost": 12.34,
  "startedAt": "2026-06-09T10:00:00Z"
}
```

**Estimated effort:** 1–2 days.

---

#### A-7: Parallel Eternal Engine — Stub File in Coordination

**What:** There's a stub file at `packages/core/src/coordination/parallel-eternal-engine.ts` that says:

> *"This file is intentionally empty — the ParallelEternalEngine lives in `packages/core/src/execution/parallel-eternal-engine.ts`. This stub exists because a prior implementation attempt wrote a partial file here."*

The actual implementation is 606 lines and lives in `execution/`. The stub should be deleted — it's dead code that could confuse contributors.

**Fix:** Delete `packages/core/src/coordination/parallel-eternal-engine.ts`.

**Estimated effort:** 5 minutes.

---

#### A-8: AutoPhase — No Cost/Time Estimation Feedback

**What:** `AutoPhasePlanner` generates phases with `taskTemplates` that include `estimatedHours` fields, but the system doesn't:
1. Track actual time per phase
2. Compare estimated vs. actual time
3. Adjust future estimates based on historical data
4. Warn when cost is trending over budget

**Why it matters:** Multi-hour autonomous runs need progress tracking that includes cost and time predictions, not just task completion counts.

**Fix:**
1. Record `startedAt` and `completedAt` per phase
2. Compare with estimates and log variance
3. Use historical data to calibrate future estimates
4. Add cost-per-phase tracking with budget alerts

**Estimated effort:** 3–5 days.

---

### 11.4 SDD (Spec-Driven Development)

#### S-5: SDD Spec Versioning — No Diff View

**What:** `spec-versioning.ts` exists and versions specs, but there's no way to view what changed between spec versions. When a spec evolves from v1 to v2, users can't see the diff.

**Fix:** Add a `/sdd diff [v1] [v2]` command that renders a markdown diff between two spec versions. The `diff` tool already exists in `packages/tools/src/diff.ts`.

**Estimated effort:** 1–2 days.

---

#### S-6: SDD Task Graph — No WebUI Visualization

**What:** `task-visualizer.ts` and `task-graph-store.ts` exist but visualization is text-only (ASCII/Mermaid). The WebUI has no SDD integration at all.

**Fix:** Add an SDD dashboard to the WebUI showing:
- Task graph as an interactive DAG (not just Mermaid)
- Progress bars per phase
- Critical path highlighting
- Click-to-expand task details

**Estimated effort:** 5–7 days.

---

### 11.5 Cloud Sync & Cross-Device

#### C-6: Cloud Sync — No Conflict Resolution

**What:** `CloudSync` (`packages/core/src/storage/cloud-sync.ts`) pushes/pulls to a private GitHub repo. It uses SHA-based state tracking but has no conflict resolution for concurrent edits from multiple devices.

**Why it matters:** If a user edits their config on two machines and both sync, the last-write-wins behavior silently drops changes.

**Fix:**
1. Detect concurrent modifications (both have unsynced changes)
2. Present a merge conflict UI (CLI prompt or WebUI dialog)
3. Keep a conflict history for manual resolution

**Estimated effort:** 3–5 days.

---

#### C-7: Cloud Sync — Only GitHub, Not GitLab/Bitbucket/Self-Hosted

**What:** Cloud sync only works with GitHub REST API. Users on GitLab, Bitbucket, or self-hosted Git servers can't sync.

**Fix:** Abstract the sync backend:
```typescript
interface SyncBackend {
  push(category: SyncCategory, content: Buffer): Promise<void>;
  pull(category: SyncCategory): Promise<Buffer | null>;
  list(): Promise<SyncCategory[]>;
}
```

Implement GitHub, GitLab, and generic Git (via CLI) backends.

**Estimated effort:** 3–5 days per backend.

---

### 11.6 Provider & Model System

#### P-4: No Provider Health Monitoring

**What:** The provider system has no built-in health monitoring. Users don't know if a provider is:
- Experiencing elevated latency
- Rate-limiting
- Returning errors at a higher rate
- About to deprecate a model

**Why it matters:** WrongStack runs for hours in autonomous mode. A degraded provider wastes tokens and time.

**Fix:**
1. Track per-provider metrics (latency p50/p95, error rate, rate limit hits)
2. Expose via `/models health` command
3. Auto-switch to fallback when primary is degraded (builds on existing `fallbackModels`)
4. Show provider status in TUI statusline and WebUI sidebar

**Estimated effort:** 3–5 days.

---

#### P-5: Model Cost Estimation — No Pre-Flight Check

**What:** Before starting a long autonomous run, there's no way to estimate how much it will cost. Users find out after the fact via `/stats`.

**Fix:** Add a `wstack estimate` command that:
1. Takes a task description
2. Estimates tokens needed (based on codebase size, task complexity)
3. Multiplies by the current model's cost per token
4. Shows a range (best case / worst case)

**Building blocks:** The cost tracker plugin already tracks real costs. Historical session data provides calibration.

**Estimated effort:** 2–3 days for a basic estimator.

---

#### P-6: Provider Presets — Missing Popular Providers

**What:** The provider presets directory (`packages/providers/src/presets/`) has 4 providers: Anthropic, Google, Mistral, OpenAI. Missing popular providers:

| Provider | Why it matters |
|----------|----------------|
| **Groq** | Ultra-fast inference, popular for YOLO mode |
| **Cohere** | Enterprise NLP |
| **DeepSeek** | Cost-effective reasoning |
| **Fireworks** | Fast open-source model hosting |
| **Together AI** | Open-source model hosting |
| **Azure OpenAI** | Enterprise compliance |
| **AWS Bedrock** | Enterprise compliance |
| **Ollama** | Local model hosting |

**Fix:** Add preset definitions (each is ~50–100 lines following the existing pattern). Most are `openai-compatible` with custom base URLs.

**Estimated effort:** 0.5–1 day per preset.

---

### 11.7 Website & Marketing

#### W-1: Website Uses ESLint + Prettier Instead of Biome

**What:** The website (`website/`) uses ESLint and Prettier, while the rest of the monorepo uses Biome. This creates:
- Two formatting configurations to maintain
- Different lint rules for website vs. main codebase
- `package-lock.json` for the website vs. `pnpm-lock.yaml` for the rest

**Fix:** Migrate the website to Biome and pnpm to match the monorepo.

**Estimated effort:** 1–2 days.

---

#### W-2: No Interactive Demo on Website

**What:** The website has a `TUIDemo.tsx` component, but it's a static mock. A real interactive demo where users can type a prompt and see WrongStack's output (simulated) would be much more compelling.

**Fix:** Create an animated terminal simulator that replays a pre-recorded session with realistic typing animation, showing tool calls, code edits, and streaming output.

**Estimated effort:** 3–5 days.

---

#### W-3: No Comparison Page

**What:** The website doesn't compare WrongStack with alternatives (Cursor, Claude Code, Aider, GitHub Copilot CLI, etc.). Users coming from those tools need a clear "why WrongStack?" answer.

**Fix:** Add a comparison page with honest, specific feature comparisons:
- Multi-agent orchestration (unique to WrongStack)
- Skill system
- Plugin ecosystem
- MCP support
- Autonomous mode
- Privacy/security model

**Estimated effort:** 2–3 days.

---

### 11.8 Examples & Learning

#### X-1: Examples Don't Cover SDD, Autophase, or Collab Debug

**What:** The `examples/` directory has 6 categories (basic, tools, providers, MCP, multi-agent, real-world). Missing examples for:
- SDD workflow (spec → tasks → execution)
- AutoPhase autonomous workflow
- Collab debug (`/collab`)
- Telegram integration
- Hooks (PreToolUse, PostToolUse, etc.)
- Custom plugin creation

**Fix:** Add 3–4 new example directories covering these features.

**Estimated effort:** 1–2 days per example.

---

#### X-2: No Video Walkthroughs

**What:** The README and docs are text-only. No animated demos, video walkthroughs, or asciinema recordings.

**Fix:** Record asciinema sessions for common workflows and embed them in the README and website.

**Estimated effort:** 1–2 days to record and edit 5–10 sessions.

---

### 11.9 Miscellaneous

#### M-1: SpecParser Uses `crypto.randomUUID()` Instead of Project-Standard ULIDs

**What:** `packages/core/src/sdd/spec-parser.ts` line 17 uses `crypto.randomUUID()`, but the project convention is ULIDs (see AGENTS.md: "IDs are ULIDs not UUIDs"). This makes specs inconsistent with sessions, goals, plans, and everything else.

**Fix:** Replace with the project's ULID generator:
```typescript
import { ulid } from '../utils/ulid.js';
// ...
id: ulid(),
```

**Estimated effort:** 5 minutes.

---

#### M-2: Shell Hook Executor — No Timeout Configuration in Config

**What:** The shell hook executor (`packages/core/src/hooks/shell-executor.ts`) has a hardcoded 5-second default timeout. Users can configure individual hook timeouts but there's no global config option.

**Why it matters:** Some hooks (linting, formatting, type checking) may need more than 5 seconds on large codebases.

**Fix:** Add a `hooks.defaultTimeoutMs` config option.

**Estimated effort:** 0.5 days.

---

#### M-3: Worktree Manager — No Pruning of Stale Worktrees

**What:** The `WorktreeManager` allocates worktrees for AutoPhase but has no mechanism to prune stale worktrees from failed or abandoned phases. Over time, `git worktree list` can accumulate zombie entries.

**Fix:** Add a `prune(maxAgeMs?)` method and a `/worktree prune` slash command.

**Estimated effort:** 1 day.

---

#### M-4: No Graceful Degradation When SQLite Is Unavailable

**What:** The codebase index uses SQLite (`packages/tools/src/shim/node-sqlite.ts`). If `node:sqlite` is not available (older Node versions, restricted environments), the tools fail with no fallback.

**Fix:** Add a graceful fallback:
1. Try `node:sqlite`
2. Fall back to `better-sqlite3` if installed
3. Fall back to in-memory JSON-based search if neither is available
4. Warn the user about degraded functionality

**Estimated effort:** 2–3 days.

---

#### M-5: No Telemetry / Anonymous Usage Statistics

**What:** WrongStack collects no usage data. This makes it hard to:
- Prioritize features based on actual usage
- Identify common failure patterns
- Track adoption growth
- Compare model popularity

**Why add it:** Every major developer tool (VS Code, npm, Rust) has opt-in telemetry. It's essential for data-driven development.

**Implementation principles:**
- **Opt-in only** — default off, explicit consent required
- **Local-first** — aggregate locally, send only summary statistics
- **Transparent** — users can see exactly what's collected
- **No secrets** — never include API keys, file contents, or project names
- **GDPR-compliant** — clear privacy policy, easy opt-out

**Data points to collect:**
- Tool usage frequency (which tools are used most)
- Provider/model popularity
- Session duration and iteration counts
- Error rates by category
- Feature adoption (SDD, autophase, multi-agent, etc.)

**Estimated effort:** 5–7 days for a working opt-in system with dashboard.

---

## 12. Revised Quick-Win Checklist

Updated to include findings from the deep scan:

| # | Item | Impact | Time |
|---|------|--------|------|
| 1 | Delete stub `coordination/parallel-eternal-engine.ts` | Dead code removal | 5 min |
| 2 | Replace `crypto.randomUUID()` with `ulid()` in spec-parser.ts | Consistency | 5 min |
| 3 | Translate Turkish comments in autophase (8 files) | Code quality | 0.5 day |
| 4 | Add `'session.close'` to EventMap or remove `as any` workaround | Type safety | 0.5 day |
| 5 | Set `mutating: true` on `cost_reset` tool | Permission correctness | 5 min |
| 6 | Add explicit re-export of `expectDefined` in core barrel | Discoverability | 5 min |
| 7 | Add unit test for canonical `expectDefined` | Test coverage | 0.5 day |
| 8 | Remove orphan docs for unimplemented slash commands | Doc accuracy | 1 day |
| 9 | Add `hooks.defaultTimeoutMs` config option | DX | 0.5 day |
| 10 | Add `/worktree prune` command | Ops hygiene | 1 day |
| 11 | Add provider presets for Groq, DeepSeek, Ollama | Coverage | 1 day |
| 12 | Migrate website from ESLint+Prettier to Biome | Consistency | 1 day |

---

## 13. Theme-Based Roadmap

For strategic planning, here are the findings grouped by theme with rough effort estimates:

### 🛡️ Security & Reliability (15–20 days)
- S-1: Complete capability migration (3–5 days)
- S-2: Secret rotation helpers (1–2 days)
- S-3: MCP server sandboxing (5–7 days)
- S-4: Audit log integrity (2–3 days)
- A-6: Eternal autonomy persistent state (1–2 days)
- T-7: Circuit breaker for all tools (2–3 days)

### 🧪 Testing & Quality (20–30 days)
- E-2: WebUI test coverage (5–7 days)
- E-3: CLI test coverage (5–7 days)
- T-1: Integration test suite (7–10 days)
- T-2: Property-based testing for kernel (3–5 days)
- A-1: File decomposition (11–13 days)

### 🚀 Developer Experience (15–20 days)
- D-1: `wstack doctor` command (2–3 days)
- D-2: Interactive onboarding wizard (3–5 days)
- D-3: Better Windows support (2–3 days)
- E-8: Better error messages (2–3 days)
- E-10: Session export formats (2–3 days per format)
- P-1: Plugin state threading (1–2 days)

### 🤖 AI & Intelligence (15–20 days)
- N-5: Semantic code search (7–10 days)
- N-9: Smart context budgeting (5–7 days)
- N-4: Compaction preview (3–5 days)
- P-4: Provider health monitoring (3–5 days)

### 🌐 Ecosystem & Community (15–20 days)
- N-3: Skill marketplace (5–7 days)
- D-4: VS Code extension (10–15 days)
- C-3: Contributing guide (2–3 days)
- X-1: Missing examples (3–8 days)

---

---

## 14. Third-Pass Deep Scan — Storage, Observability, Fleet, DX

Additional findings from scanning storage layer, observability, fleet agent definitions, TUI hooks, WebUI stores, Telegram integration, build system, and memory system.

---

### 14.1 Memory System

#### M-6: Memory Store Has a 32 KB Hard Limit with No Tiered Storage

**What:** `DefaultMemoryStore` has a hardcoded `MAX_BYTES_TOTAL = 32_000` (~8K tokens). When memory exceeds this, the consolidator must compress or delete entries. There's no tiered storage (hot/recent vs. cold/archived).

**Why it matters:** For long-lived projects, 32 KB of memory is insufficient. The agent forgets important architectural decisions from months ago because they were consolidated away to make room.

**Fix:**
1. Add tiered storage: hot (recent, full fidelity), warm (older, compressed), cold (ancient, summary-only)
2. Make the limit configurable per scope
3. Add a "memory budget" concept (X tokens for project, Y for user-global)
4. Let memory overflow to disk-based vector storage when the in-memory budget is full

**Building blocks:** `MemoryConsolidator` already handles compression. `GraphMemoryBackend` tracks relationships. These can be extended for tiered storage.

**Estimated effort:** 5–7 days.

---

#### M-7: GraphMemoryBackend Exists but Isn't Wired by Default

**What:** `GraphMemoryBackend` (`packages/core/src/storage/memory-graph-backend.ts`) is a sophisticated graph-based memory backend that tracks co-occurrence, similarity, and turn-based relationships between memory entries. It supports graph traversal queries (`findRelated`).

**But:** The default `DefaultMemoryStore` uses `FileMemoryBackend` (flat markdown). The graph backend is available as a pluggable backend but isn't wired by default. Most users never benefit from it.

**Why it matters:** Graph-based memory would let the agent find related memories much more effectively. "Remember that bug with auth?" could traverse the graph to find related entries about tokens, sessions, and providers.

**Fix:**
1. Wire `GraphMemoryBackend` as the default for `project-memory` scope
2. Keep `FileMemoryBackend` for `project-agents` (AGENTS.md) and `user-memory` (simple markdown)
3. Add a `/memory graph` command to visualize relationships
4. Add a `/memory search <query>` command that uses graph traversal

**Estimated effort:** 3–5 days.

---

#### M-8: Memory Consolidator Uses LLM — But No Cost Awareness

**What:** `MemoryConsolidator` (`packages/core/src/storage/memory-consolidator.ts`) is an `AgentExtension` that fires after every run. It sends the existing memory entries + session summary to the LLM and asks it to produce consolidation operations (add/edit/delete).

**But:** It doesn't track how much the consolidation itself costs. On a long session, consolidation can cost $0.05–$0.10 per run. With eternal autonomy doing hundreds of runs, this adds up significantly.

**Fix:**
1. Log consolidation cost explicitly
2. Allow users to configure consolidation frequency (every N runs, not every run)
3. Support a cheaper model for consolidation (the `model` option exists but isn't advertised)
4. Add a budget threshold: skip consolidation if session cost is already over X

**Estimated effort:** 1–2 days.

---

### 14.2 Observability

#### O-1: Prometheus Metrics — No Dashboard Template

**What:** `packages/core/src/observability/prometheus.ts` renders metrics in Prometheus text format. `otel-tracer.ts`, `otlp-metrics.ts`, and `otlp-traces.ts` support OpenTelemetry export. But there's no pre-built Grafana dashboard JSON or Prometheus alerting rules.

**Why it matters:** Users who enable `--metrics` get raw Prometheus endpoints but must build their own dashboards from scratch. A pre-built dashboard would make observability immediately useful.

**Fix:** Ship a `contrib/` directory with:
1. `grafana-dashboard.json` — pre-built WrongStack dashboard
2. `prometheus-alerts.yml` — alerting rules (high error rate, budget exceeded, session stuck)
3. `docker-compose.observability.yml` — Prometheus + Grafana + OTel Collector stack

**Estimated effort:** 2–3 days.

---

#### O-2: Health Registry — No Automatic Health Checks

**What:** `packages/core/src/observability/health.ts` provides a `HealthRegistry` interface, but health checks must be manually registered by each subsystem. There are no automatic health checks for:
- Session storage integrity
- MCP server connectivity
- Provider API reachability
- Disk space in session directory
- Memory store consistency

**Fix:** Register built-in health checks at boot time for critical subsystems. Expose via `wstack health` and `--metrics`.

**Estimated effort:** 2–3 days.

---

#### O-3: OTLP Traces — No Sampling Strategy

**What:** `otlp-traces.ts` exports traces via OpenTelemetry, but every tool call and provider request generates a span. In a 500-iteration autonomous session, this produces tens of thousands of spans.

**Fix:** Add configurable sampling:
- Always trace errors and slow calls
- Sample 10% of normal tool calls
- Sample 1% of fast reads
- Let users configure the sampling rate

**Estimated effort:** 1–2 days.

---

### 14.3 Session Analysis & Replay

#### R-1: SessionAnalyzer — Basic Analysis Only

**What:** `SessionAnalyzer` (`packages/core/src/storage/session-analyzer.ts`) is only 150 lines and produces a basic analysis: tool usage counts, error count, mode changes, and task summaries. It doesn't produce:

- **Cost trend analysis** (cost per iteration over time)
- **Tool failure clustering** (which tools fail together)
- **Context growth tracking** (token usage per iteration)
- **Decision quality scoring** (did the agent make good choices?)
- **Time-to-resolution metrics** (how long from first attempt to success)
- **Tool sequence patterns** (common tool chains)

**Why it matters:** The `audit-log` skill expects rich session analysis. The current analyzer provides only surface-level statistics.

**Fix:** Extend `SessionAnalyzer` with:
1. Per-iteration cost tracking
2. Tool failure pattern detection
3. Context growth timeline
4. Tool sequence mining (frequent tool chains)
5. Export as structured JSON for dashboard consumption

**Estimated effort:** 5–7 days.

---

#### R-2: ReplayLogStore — Not Wired into Default Boot

**What:** `ReplayLogStore` (`packages/core/src/storage/replay-log-store.ts`) is a well-designed sidecar store that records provider request/response pairs for deterministic replay. But it's not wired into the default boot flow — it's only activated when the user explicitly enables replay mode.

**Why it matters:** Replay is one of the most powerful features (N-1 in this report). But users don't know it exists because it's opt-in with no UI affordance.

**Fix:**
1. Add a `/replay record on` slash command
2. Show a hint when replay is available: "This session can be replayed. Use `/replay` to step through."
3. Add a `wstack replay list` command to find replayable sessions

**Estimated effort:** 2–3 days.

---

#### R-3: ToolAuditLog Uses `randomUUID` Instead of ULID

**What:** `packages/core/src/storage/tool-audit-log.ts` line 2 imports `randomUUID` from `node:crypto`. Same issue as M-1 — project convention is ULIDs.

**Fix:** Same as M-1 — replace with project's ULID generator.

**Estimated effort:** 5 minutes.

---

#### R-4: AnnotationsStore — No UI for Viewing/Managing Annotations

**What:** `AnnotationsStore` (`packages/core/src/storage/annotations-store.ts`) is a well-designed sidecar store for collaboration annotations. It supports add, resolve, delete, and query. But there's no TUI or WebUI component to view or manage annotations.

**Fix:** Add annotation rendering in:
1. TUI history view (show annotations inline with events)
2. WebUI chat view (click on a message to add/view annotations)
3. `/annotations` slash command for CLI management

**Estimated effort:** 3–5 days for TUI + WebUI integration.

---

### 14.4 Fleet & Agent Definitions

#### F-1: 47 Agent Roles — No Documentation for Most

**What:** The fleet roster has 47 agent roles across 9 phases (discovery → meta). Each agent has a detailed prompt, budget tier, tool set, and capability metadata. But this catalog is not documented anywhere users can discover it.

**Why it matters:** Users don't know what agents are available. They can't make informed choices about which agent to dispatch for a task.

**Fix:**
1. Add `/fleet catalog` command that lists all agents with descriptions
2. Add a `fleet.catalog` page to the WebUI
3. Document the 9-phase system and agent roles in `docs/director-architecture.md`
4. Add `wstack fleet catalog --format json` for programmatic access

**Estimated effort:** 2–3 days.

---

#### F-2: Smart Dispatcher Has No Learning / Feedback Loop

**What:** The `dispatcher.ts` uses a two-stage strategy: heuristic keyword scoring + optional LLM fallback. It works well for clear-cut tasks but has no feedback mechanism:

- It doesn't learn from past dispatches (was the chosen agent successful?)
- It doesn't adjust keyword weights based on outcomes
- It doesn't track which agents are consistently over/under-utilized
- It doesn't consider current agent load (all 47 agents are equal candidates)

**Fix:**
1. Track dispatch outcomes (success/failure/timeout per agent)
2. Adjust heuristic weights based on historical success rates
3. Add load-awareness: prefer idle agents over busy ones
4. Add a "dispatch reason" in the fleet status so users understand routing decisions

**Estimated effort:** 3–5 days.

---

#### F-3: Auto-Extend Policy — No User Visibility

**What:** `AutoExtendPolicy` (`packages/core/src/coordination/auto-extend.ts`) automatically extends subagent budgets when they hit soft limits, with heartbeat-aware timeout handling and per-kind extension caps. But users have no visibility into:

- How many extensions were granted per agent
- Why an agent's budget was extended
- What the current effective budget is (original + extensions)
- When an extension was denied (and why)

**Fix:**
1. Emit `subagent.budget_extended` events with details (which limit, old/new value, reason)
2. Show extension history in fleet status
3. Add a `--budget-strict` flag to disable auto-extend for debugging
4. Log extension decisions to the session JSONL

**Estimated effort:** 2–3 days.

---

### 14.5 Telegram Integration

#### T-9: Telegram Bot — No Command Handling

**What:** The Telegram bot (`packages/telegram/src/bot.ts`) receives messages and emits `TelegramIncomingMessage` events. But there's no built-in command handling:

- No `/status` command to check session state
- No `/stop` command to abort a running task
- No `/model` command to switch models
- No `/cost` command to check spending
- No approval flow for tool calls via Telegram

**Why it matters:** Users who monitor WrongStack via Telegram can see output but can't control it. They must switch to the terminal/WebUI for any interaction.

**Fix:** Add Telegram command handlers for:
1. `/status` — current session state, iteration, cost
2. `/stop` — abort current run
3. `/model <name>` — switch model
4. `/approve` — approve a pending tool call
5. `/deny` — deny a pending tool call
6. `/cost` — cost summary

**Estimated effort:** 3–5 days.

---

#### T-10: Telegram — No Rate Limiting or Spam Protection

**What:** The Telegram bot processes every incoming message as a potential prompt. There's no rate limiting, no user allowlist, and no spam filtering.

**Why it matters:** Anyone who knows the bot token can send unlimited messages, which translates to unlimited WrongStack agent runs (and unlimited API costs).

**Fix:**
1. Add a configurable user allowlist (Telegram user IDs)
2. Add per-user rate limiting (X messages per minute)
3. Add message length limits
4. Add a cost guard: stop processing messages when session cost exceeds a threshold

**Estimated effort:** 1–2 days.

---

### 14.6 Build System & Infrastructure

#### B-1: Build Script Has Windows-Specific Workaround

**What:** `scripts/build.mjs` has a 20-line comment explaining a pnpm 11 + cmd.exe compatibility issue:

> *"pnpm 11's `; echo "EXIT=$?"` wrapper, which cmd.exe does not understand as a separator"*

The build script manually discovers packages and runs their build scripts to bypass this. This is fragile — if pnpm fixes the issue or changes the wrapper, the script breaks silently.

**Fix:**
1. Track the pnpm issue and remove the workaround when fixed
2. Add a version check that warns when the workaround may be unnecessary
3. Consider switching to `tsx scripts/build.mjs` with explicit `--shell bash` on Windows

**Estimated effort:** 0.5–1 day.

---

#### B-2: No CI/CD Pipeline Configuration

**What:** The security hardening plan references `.github/workflows/ci.yml` and `release.yml`, but these files don't exist in the repository. There are no CI workflows for:

- Automated testing on push/PR
- Automated type checking
- Automated linting
- Automated security audits
- Release automation
- Cross-platform testing (Windows, macOS, Linux)

**Why it matters:** Without CI, there's no automated gate preventing regressions from reaching main.

**Fix:** Create GitHub Actions workflows:
1. `ci.yml` — test + typecheck + lint + audit on every PR
2. `release.yml` — build + publish on tag push
3. `weekly-audit.yml` — scheduled security audit
4. Matrix testing: ubuntu-latest, macos-latest, windows-latest

**Estimated effort:** 2–3 days.

---

#### B-3: WebUI Uses Core-Browser-Shim for a Single Export

**What:** `packages/webui/src/lib/core-browser-shim.ts` is a 19-line file that exists solely to re-export `expectDefined` from `@wrongstack/core/utils/expect-defined`:

```typescript
export { expectDefined } from '@wrongstack/core/utils/expect-defined';
```

**Why it matters:** If the WebUI only needs `expectDefined` from core, it should import it directly from the subpath export. The shim adds indirection and maintenance burden.

**Fix:**
1. Import `expectDefined` directly in the WebUI components that need it
2. If Vite can't handle the subpath import, fix the Vite config alias
3. Delete the shim

**Estimated effort:** 0.5 days.

---

#### B-4: No Automated Dependency Update Strategy

**What:** The project has no automated dependency update strategy (no Dependabot, Renovate, or similar). The `outdated` tool exists but must be run manually.

**Fix:**
1. Add Dependabot or Renovate configuration
2. Auto-merge minor/patch updates that pass CI
3. Review major updates manually
4. Exclude the website from monorepo-wide updates (it uses a separate lockfile)

**Estimated effort:** 0.5–1 day to configure.

---

### 14.7 TUI Architecture

#### T-11: TUI Event Bridge — No Error Boundary

**What:** `useTuiEventBridge` (`packages/tui/src/hooks/use-tui-event-bridge.ts`) subscribes to ~50 EventBus events and dispatches reducer actions. If any event handler throws, the subscription is lost silently — the TUI stops updating but doesn't crash or show an error.

**Why it matters:** Users see a frozen TUI with no feedback. They can't tell if the agent stopped or the UI broke.

**Fix:** Add error boundaries around each event subscription:
```typescript
events.on('provider.text_delta', (e) => {
  try {
    dispatch({ type: 'textDelta', ... });
  } catch (err) {
    dispatch({ type: 'error', message: `UI error: ${err}` });
  }
});
```

**Estimated effort:** 1 day.

---

#### T-12: TUI Components Not Extracted as a Library

**What:** The TUI has 30+ well-designed Ink/React components: fleet monitor, goal panel, phase monitor, process list, status bar, slash menu, etc. These are valuable building blocks that other terminal applications could use.

**Fix:**
1. Extract a `@wrongstack/tui-components` package with generic Ink components
2. Keep WrongStack-specific wiring in `@wrongstack/tui`
3. Publish as a separate package for the Ink/React community

**Why it matters:** WrongStack's TUI is one of the most sophisticated Ink applications. Publishing the components would grow the ecosystem and attract contributors.

**Estimated effort:** 5–7 days for extraction + documentation.

---

#### T-13: No TUI Theming / Customization

**What:** The TUI has a hardcoded color scheme in `packages/tui/src/theme.ts`. Users can't customize:
- Color palette (for accessibility or personal preference)
- Layout (compact vs. spacious)
- Key bindings (for non-QWERTY keyboards)
- Font size (for high-DPI terminals)

**Fix:** Add a `~/.wrongstack/tui-theme.json` configuration file:
```json
{
  "colors": { "primary": "#00ff00", "error": "#ff0000" },
  "compact": true,
  "keyBindings": { "fleet": "Ctrl+F" }
}
```

**Estimated effort:** 2–3 days.

---

### 14.8 WebUI Architecture

#### W-4: WebUI Stores — Zustand with No Devtools Integration

**What:** The WebUI uses Zustand stores (`chat-store.ts`, `fleet-store.ts`, `session-store.ts`, etc.) but doesn't integrate Zustand devtools. Developers can't inspect state changes during debugging.

**Fix:** Add devtools middleware in development mode:
```typescript
export const useFleetStore = create<FleetState>()(
  process.env.NODE_ENV === 'development' ? devtools(set => ({ ... })) : (set => ({ ... }))
);
```

**Estimated effort:** 0.5 days.

---

#### W-5: WebUI Has No Keyboard Shortcuts System

**What:** The WebUI has no keyboard shortcuts. The TUI has rich key bindings (Ctrl+F for fleet, Ctrl+G for agents, F9 for goal, Esc to close panels). The WebUI has none.

**Fix:** Add a keyboard shortcut system:
- `Cmd/Ctrl+K` — command palette
- `Cmd/Ctrl+B` — toggle sidebar
- `Cmd/Ctrl+Shift+F` — search overlay
- `Escape` — close modals/panels

**Estimated effort:** 2–3 days.

---

#### W-6: WebUI Fleet Store — No Historical Data

**What:** The `useFleetStore` Zustand store only tracks live subagent state. When a subagent completes, its entry is eventually overwritten. There's no fleet history — users can't review past fleet activity.

**Fix:**
1. Keep completed subagent entries for the session duration
2. Add a "completed" tab to the fleet panel
3. Persist fleet history to session JSONL (director already does this via `fleet.json`)

**Estimated effort:** 2–3 days.

---

#### W-7: WebUI — No Mobile-Responsive Layout

**What:** The WebUI is designed for desktop browsers. The sidebar, chat view, and settings panel don't adapt to mobile screen sizes.

**Why it matters:** Users want to monitor WrongStack on their phones, especially during long autonomous runs.

**Fix:** Add responsive breakpoints for:
- Sidebar → hamburger menu on mobile
- Chat view → full-width on mobile
- Settings → full-screen modal on mobile
- Fleet panel → tab-based navigation on mobile

**Estimated effort:** 3–5 days.

---

### 14.9 Autonomy Prompt Engineering

#### A-9: Autonomy Prompt Contributor — Not Versioned

**What:** `autonomy-prompt-contributor.ts` injects an "autonomy-state" block into the system prompt on every turn. The block contains the goal state, journal tail, and iteration counter. But there's no versioning — if the prompt format changes, old sessions can't be replayed with the new format.

**Fix:** Add a `version` field to the prompt block:
```typescript
{ version: 2, goal: ..., journal: ..., iteration: ... }
```

And maintain backward compatibility in the parser.

**Estimated effort:** 0.5–1 day.

---

#### A-10: No "Autonomy Pause" via Natural Language

**What:** The eternal autonomy engine (`EternalAutonomy`) runs until `stop()` is called externally (SIGINT, `/autonomy stop`). But there's no way to pause via natural language — saying "hold on, let me review" in the chat doesn't pause the loop.

**Why it matters:** Users interact with the agent conversationally. Having to use a slash command or Ctrl+C to pause is a mode mismatch.

**Fix:** Add natural language pause detection:
1. Watch for pause signals in user input ("wait", "hold on", "pause", "stop")
2. Enter a paused state that waits for user confirmation before continuing
3. Resume via "continue", "go ahead", "resume"

**Estimated effort:** 2–3 days.

---

### 14.10 Queue & Task Management

#### Q-1: QueueStore — No Priority or Scheduling

**What:** `QueueStore` (`packages/core/src/storage/queue-store.ts`) persists queued user messages as a flat array. There's no priority ordering, no scheduled delivery (send at 8am), and no conditional delivery (send when tests pass).

**Fix:**
1. Add priority levels (low, normal, high)
2. Add scheduled delivery (ISO timestamp)
3. Add conditional delivery (event trigger: "when tool X succeeds")
4. Add queue size limits and eviction policies

**Estimated effort:** 3–5 days.

---

#### Q-2: No Cross-Session Task Handoff

**What:** Sessions are isolated. If session A creates a plan with tasks, session B can't pick up where A left off. The plan store persists, but the execution context (what was done, what failed, what was learned) is lost.

**Fix:**
1. Add a "session handoff" protocol: when session A ends, write a handoff summary
2. Session B reads the handoff summary and continues from the same state
3. Include: completed tasks, failed attempts, learned patterns, file state

**Why it matters:** Multi-session workflows are common. Users start a task, close WrongStack, and come back the next day. Currently they must re-explain the context from scratch.

**Estimated effort:** 5–7 days.

---

## 15. Revised Totals

| Category | Count |
|----------|-------|
| New feature ideas (N-1 to N-10) | 10 |
| Existing improvements (E-1 to E-10) | 10 |
| Architecture & code quality (A-1 to A-10) | 10 |
| Developer experience (D-1 to D-5) | 5 |
| Testing & QA (T-1 to T-13) | 13 |
| Security & hardening (S-1 to S-6) | 6 |
| Documentation & community (C-1 to C-7) | 7 |
| Plugin system (P-1 to P-6) | 6 |
| Provider & model (P-4 to P-6) | 3 |
| Website (W-1 to W-7) | 7 |
| Examples (X-1 to X-2) | 2 |
| Observability (O-1 to O-3) | 3 |
| Session & replay (R-1 to R-4) | 4 |
| Fleet & agents (F-1 to F-3) | 3 |
| Telegram (T-9 to T-10) | 2 |
| Build & infra (B-1 to B-4) | 4 |
| TUI architecture (T-11 to T-13) | 3 |
| WebUI architecture (W-4 to W-7) | 4 |
| Autonomy (A-6 to A-10) | 5 |
| Queue & tasks (Q-1 to Q-2) | 2 |
| Miscellaneous (M-1 to M-8) | 8 |
| **Quick wins** | **12** |
| **Total unique findings** | **~117** |

---

## 16. Revised Theme Roadmap

### 🛡️ Security & Reliability (20–25 days)
- S-1: Complete capability migration
- S-2: Secret rotation helpers
- S-3: MCP server sandboxing
- S-4: Audit log integrity
- A-6: Eternal autonomy persistent state
- T-7: Circuit breaker for all tools
- T-10: Telegram spam protection

### 🧪 Testing & Quality (25–35 days)
- E-2: WebUI test coverage
- E-3: CLI test coverage
- T-1: Integration test suite
- T-2: Property-based testing
- A-1: File decomposition
- B-2: CI/CD pipeline setup

### 🚀 Developer Experience (20–25 days)
- D-1: `wstack doctor`
- D-2: Interactive onboarding
- D-3: Better Windows support
- E-8: Better error messages
- P-1: Plugin state threading
- T-13: TUI theming
- W-5: WebUI keyboard shortcuts

### 🤖 AI & Intelligence (20–25 days)
- N-5: Semantic code search
- N-9: Smart context budgeting
- M-6: Tiered memory storage
- M-7: Wire GraphMemoryBackend by default
- F-2: Smart dispatcher feedback loop
- A-10: Natural language autonomy pause

### 🌐 Ecosystem & Community (20–25 days)
- N-3: Skill marketplace
- D-4: VS Code extension
- T-12: Extract TUI components as library
- W-7: Mobile-responsive WebUI
- C-3: Contributing guide
- F-1: Fleet catalog documentation

### 📊 Observability & Ops (10–15 days)
- O-1: Grafana dashboard template
- O-2: Automatic health checks
- R-1: Enhanced session analysis
- M-5: Opt-in telemetry
- P-4: Provider health monitoring
- F-3: Auto-extend visibility

---

*End of report. Total: ~117 unique findings across 21 categories, organized into 16 sections with theme-based roadmap estimates.*
