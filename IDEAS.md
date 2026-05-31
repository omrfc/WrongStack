# WrongStack — Strategic Ideas

This document outlines concrete, differentiated ideas that would meaningfully advance WrongStack's architecture, competitiveness, and long-term vision. Each idea is grounded in WrongStack's existing infrastructure (multi-agent fleet, director-coordinator pattern, SDD phases, ACP, observability layer) and targets gaps in current AI coding assistants like Claude Code, Codex, and Cursor.

---

## 1. Collaborative Debugging Session — Parallel Expertise on the Same Problem

**Concept:** Bug Hunter, Refactor Planner, and Critic agents work simultaneously on the same file(s), not sequentially. While Bug Hunter isolates the defect, Refactor Planner generates the remediation plan in parallel, and Critic evaluates both in real time. The result is a multi-perspective diagnosis delivered in a single pass.

**Why it matters:** Today's multi-agent systems run agents in isolation — each sees the code independently, and results are merged afterward. This creates two problems: (a) **temporal latency** — Agent B can't start until Agent A finishes, and (b) **gorilla debugging** — Agent A finds a bug that Agent B, running independently, would have caught too, but didn't because it never saw the same context. Real engineering teams work in parallel on the same problem. WrongStack should replicate that.

**What's missing in competitors:** Claude Code and Codex are fundamentally single-agent or sequential multi-agent. They lack shared read streams, dependency-aware result passing, and real-time cross-agent evaluation.

**Implementation approach:** Extend `director.spawnCollab(task, [bugHunter, refactorPlanner, critic], { sharedFiles: [...] })`. All agents in the collab session share a **file read stream** — they read the same file snapshot at session start and receive incremental diffs as other agents modify state. A **dependency graph** tracks which agent's output feeds into another agent's input, enabling directed result passing without full synchronization. The Director acts as a **bus** collecting outputs and routing them: `bugHunter.emit('bug.found', { loc, severity })` → `refactorPlanner.on('bug.found', handle)` → `critic.on(['bug.found', 'refactor.plan'], evaluate)`.

**Key primitives:**
- `SharedFileSnapshot` — immutable snapshot of target files at collab start
- `IncrementalDiffStream` — real-time patches as agents modify state
- `CrossAgentDependencyGraph` — DAG of which agent waits on which output
- `ResultRouter` — Director-level routing of structured events between agents

**Deliverable:** A single `collab debug<target>` command that produces a structured report containing: bug location + severity, refactor plan, and critic score — in one pass, with parallel execution.

---

## 2. Deterministic Replay & Rewind — Every Decision Revisitable

**Concept:** Every agent action — tool calls, spawn decisions, message emissions — is written to an append-only event log. From any point in the session, you can say `replay from step N` and the Director will reconstruct the full state at that moment. You can also branch: "replay from step N but with a different decision at step M" — enabling alternative timeline exploration.

**Why it matters:** In Claude Code or Codex, once a decision is made, it's irreversible. If an agent deletes the wrong file, applies the wrong refactor, or routes to the wrong subagent, there's no going back. WrongStack already has the `audit-log` infrastructure — the fleet bus captures events. This idea is about making that event log **replayable**, not just readable.

**What's missing in competitors:** None of the current AI coding assistants offer replay or rewind. This is a direct differentiation play.

**Implementation approach:** Each `tool_use` event is serialized as:
```typescript
interface FleetEvent {
  id: string;           // UUID
  seq: number;          // Monotonically increasing
  timestamp: number;
  agentId: string;
  action: 'tool_use' | 'spawn' | 'emit' | 'decision';
  payload: SerializedToolCall | SpawnParams | EventData;
  output?: string;      // Tool output (truncated if large)
}
```
`FleetSession` becomes an **event-sourced aggregate**. `rewindTo(eventId)` replays all events up to and including `eventId`, discarding subsequent ones. `branchAt(eventId, overrides)` replays up to `eventId`, then injects an alternative decision and continues. The event log lives in `.wrongstack/sessions/<sessionId>/events.jsonl`.

**Key primitives:**
- `EventStore` — append-only log with replay and branch capabilities
- `StateReconstructor` — replays events to rebuild Director + agent state
- `TimelineBranch` — alternative execution path with override injection
- `EventSerializer` — handles truncation, large output chunking, and binary data

**Deliverable:** A `ws session replay <sessionId> --from <step>` command and a `ws session branch <sessionId> --at <step> --override<decision>` command. The fleet monitor gains a "timeline scrubber" UI showing the event stream with branch points.

---

## 3. Symbolic Contract Verification — Beyond Pattern Matching

**Concept:** Agents don't just match syntactic patterns ("this function uses `any`"). They infer and verify **contracts** — preconditions, postconditions, and invariants — using symbolic execution. When a contract is violated, the agent produces a causal trace: "if `getUser()` returns `null`, the call chain at `auth.ts:42 → profile.ts:17 → dashboard.ts:8` will throw."

**Why it matters:** Pattern-based bug detection (regex for `any`, heuristics for missing null checks) finds **correlations**, not **causes**. A `any` cast might be perfectly safe in one context and catastrophic in another. Symbolic execution answers: "given this input, what are all possible execution paths, and which ones violate the caller's expectations?" This is the difference between a linter and a proof.

**What's missing in competitors:** No AI coding assistant performs symbolic contract inference. They rely on training data patterns or static analysis rules baked in at development time.

**Implementation approach:** During the SDD `delivery` phase, each agent runs a **Contract Inference Layer** over the target code. This layer:
1. Parses function signatures and identifies **implicit contracts** (what does the caller assume? what does the callee guarantee?)
2. Generates **edge case candidates** — null inputs, empty collections, boundary values, concurrent access patterns
3. Simulates execution paths symbolically (not actually executing, but tracing data flow)
4. Exports contracts to `.wrongstack/contracts/<file>.json`:
```typescript
interface Contract {
  file: string;
  function: string;
  preconditions: string[];
  postconditions: string[];
  invariants: string[];
  violations: ContractViolation[];
}
```
On subsequent runs, contracts are loaded and verified before changes are applied. Violations block the delivery phase with a structured report.

**Key primitives:**
- `ContractInferrer` — symbolic execution over the target code's AST
- `EdgeCaseGenerator` — automatic derivation of boundary conditions
- `ContractStore` — persisted `.wrongstack/contracts/` directory
- `ContractVerifier` — pre-delivery validation against known contracts
- `ViolationTracer` — causal trace from violation to root cause

**Deliverable:** `ws verify contracts <target>` — validates code against inferred contracts and blocks delivery if violations are found. `ws infer contracts <target>` — runs the inference layer on demand.

---

## 4. Zero-Cost Observability — Instrumentation as a First-Class Agent Output

**Concept:** Every time an agent modifies a file, the system automatically suggests minimal instrumentation for that change — OpenTelemetry spans, metric counters, structured log statements — without requiring a separate configuration step or YAML file. The agent's context already knows what changed; leverage that to infer what should be observed.

**Why it matters:** Observability is treated as a separate concern in every project. The agent writes the code, and a different team (or the same engineer, later) adds telemetry. This separation is a maintenance burden and a frequent source of gaps — functions that weren't instrumented when they should have been. WrongStack's agent already reads and writes the code. It knows which functions are hot paths, which handle external I/O, and which manage state. It can infer instrumentation from context.

**What's missing in competitors:** Claude Code and Codex produce code without telemetry. Users must manually add spans, metrics, and logs. Cursor has some auto-instrumentation but it's rule-based and not context-aware.

**Implementation approach:** Register a handler on the Director's event bus:
```typescript
director.on('file_modified', async (path: string, diff: Diff) => {
  const suggestions = await inferInstrumentation(path, diff);
  return suggestions; // Returns { spans: [], metrics: [], logs: [] }
});
```
`inferInstrumentation` analyzes: (a) the diff — new function calls, I/O operations, state mutations; (b) existing instrumentation in the file — to avoid duplication; (c) the function's position in the call graph — to suggest proper span nesting. Suggestions are presented to the agent as structured tool results, not user-facing dialogs.

**Key primitives:**
- `InstrumentationInferrer` — analyzes diffs and call graphs to suggest telemetry
- `TelemetryTemplateLibrary` — pre-built span/metric/log templates by operation type
- `SpanNester` — infers proper OpenTelemetry parent-child relationships from call graph
- `InstrumentationApplicator` — applies approved suggestions to the target file

**Deliverable:** A `ws observability suggest<target>` command that shows what instrumentation would be added. An optional `ws observability apply --auto` mode that applies suggestions automatically for low-risk additions (log statements, basic spans) and prompts for high-risk ones (metric definitions).

---

## 5. Dependency Reasoning Engine — Semver-Aware Update Intelligence

**Concept:** `audit fix` isn't just a version bump. The agent understands semver constraints, identifies breaking changes, maps which code paths use which API surfaces, and simulates update effects before applying them. "Upgrading `axios` 0.21→1.0 will change `response.data` from `any` to `AxiosResponse` — your code at `src/api/client.ts:42` relies on the `any` behavior and will break."

**Why it matters:** `pnpm outdated` lists packages. It doesn't tell you which of your code will break, which tests will fail, or what the migration path looks like. WrongStack's code-understanding capability is exactly what's needed here — it can trace import graphs, identify API usage patterns, and predict breakage with precision.

**What's missing in competitors:** Cursor and Claude Code have basic dependency awareness but no API-surface-level tracing. They can't answer "which specific line of my code will break and why."

**Implementation approach:** Build a `DependencyGraph` module that:
1. Parses every package's `exports` map and `types` declarations
2. Maps code-level imports to specific exported symbols (`import { foo } from 'pkg'` → `pkg.foo`)
3. Builds a **UsageGraph**: `{ package: string, export: string, usedBy: [{ file, line, context }] }`
4. `simulateUpdate(pkg, newVersion)` — compares old and new API surfaces, intersects with UsageGraph, reports affected files with specific breakage explanations

```typescript
interface UpdateSimulation {
  package: string;
  fromVersion: string;
  toVersion: string;
  breaking: BreakingChange[];
  affectedFiles: AffectedFile[];
  safe: boolean;
}

interface BreakingChange {
  export: string;
  type: 'removed' | 'signature_changed' | 'behavior_changed';
  impact: string;  // Human-readable explanation
  affectedCode: { file: string; line: number; code: string }[];
}
```

**Key primitives:**
- `PackageAPISurface` — parsed exports/types for a specific package version
- `UsageGraph` — maps import symbols to usage sites in the codebase
- `UpdateSimulator` — compares two API surfaces and reports deltas
- `MigrationPathGenerator` — suggests code changes needed to adapt to breaking changes

**Deliverable:** `ws deps simulate<package>@<version>` — shows what would break. `ws deps upgrade<package>@<version> --dry-run` — full simulation before applying. `ws deps audit --semver-aware` — audit that understands semver constraints, not just version comparisons.

---

## 6. Living Documentation — Docs That Follow the Code

**Concept:** On every PR or file change, the agent automatically updates the corresponding `docs/` entries. Function signatures generate JSDoc. API endpoint changes propagate to `docs/api.md`. Architecture decisions are recorded in `docs/adr/`. The documentation doesn't decay because it's maintained in the same pass as the code.

**Why it matters:** Documentation decay is a universal problem. The code changes, the docs don't. Agentic coding assistants are in a unique position to solve this — the agent is already reading the code, already making the change, already generating a commit message. Adding a doc sync step to that workflow is low-cost and high-value.

**What's missing in competitors:** Claude Code, Codex, and Cursor do not update documentation automatically. This is a workflow feature they haven't addressed.

**Implementation approach:** Extend the SDD `delivery` phase with a **Sync Docs** step. The agent maintains a **Doc Map** — a manifest that tracks which source files map to which docs:
```typescript
interface DocMap {
  entries: {
    sourceFile: string;
    docs: string[];       // e.g., ['docs/api.md', 'docs/auth.md']
    lastSynced: string;   // commit hash
    syncStrategy: 'signature' | 'api_endpoint' | 'manual';
  }[];
}
```
On each file change, the agent: (a) checks if the file has a doc map entry, (b) applies the appropriate sync strategy — signature changes update JSDoc in the source file itself (already supported by `document` tool), API changes update `docs/api.md` with a diff, manual entries get a prompt to the user. The Doc Map is stored in `.wrongstack/doc-map.json`.

**Key primitives:**
- `DocMap` — manifest linking source files to documentation
- `SignatureSync` — JSDoc/TSDoc generation from function signatures
- `APIDocSync` — `docs/api.md` update from route/endpoint changes
- `ADRSync` — Architecture Decision Record creation from significant refactors
- `SyncValidator` — verifies that docs and code are in sync before delivery

**Deliverable:** `ws docs sync` — syncs all documentation. `ws docs status` — shows which docs are out of sync. `ws docs diff <doc>` — shows what would change. The delivery phase blocks if a doc entry is out of sync beyond a configurable threshold.

---

## 7. Semantic Architecture Enforcement — Rules, Not Just Suggestions

**Concept:** Project layer rules (`core/` = pure logic only, `adapters/` = I/O only, `services/` = stateful) are defined as a declarative DSL. An `EnforcerAgent` runs on every commit/PR, validates against these rules, and blocks the build if architectural violations are found. This is Refactor Planner used not just for planning, but for enforcement.

**Why it matters:** Architectural decay — "the auth logic somehow ended up in the UI layer" — is one of the most common sources of long-term maintenance burden. It's invisible to linters (there's no ESLint rule for "auth doesn't belong in `views/`"), and it's caught too late in code review. WrongStack's `refactor-planner` already understands architectural intent. Turning that understanding into a blocking enforcement mechanism is the natural next step.

**What's missing in competitors:** No AI coding assistant enforces architectural rules. They suggest refactors but don't block commits.

**Implementation approach:** Define `architecture-rules.ts` as a declarative rule set:
```typescript
const rules: ArchitectureRule[] = [
  {
    id: 'layer-boundary',
    description: 'adapters/ may only import from core/',
    predicate: (ctx) => {
      const imports = ctx.getImports('adapters/**/*');
      return imports.every(i => i.from.startsWith('core/') || i.from.startsWith('shared/'));
    },
    severity: 'error',
    message: 'adapters/ may not import from layers above it',
  },
  {
    id: 'no-side-effects-in-core',
    description: 'core/ must be pure functions',
    predicate: (ctx) => {
      return ctx.getFiles('core/**/*').every(f =>
        !f.body.some(n => n.type === 'AwaitExpression') &&
        !f.body.some(n => n.type === 'CallExpression' && isIO(n.callee))
      );
    },
    severity: 'error',
  },
];
```
`EnforcerAgent` runs on every commit, evaluates all predicates, and blocks with a structured violation report if any `error`-severity rule is violated. Warnings are reported but don't block.

**Key primitives:**
- `ArchitectureRuleSet` — declarative DSL for layer and dependency rules
- `PredicateEvaluator` — runs predicates against the project's AST and import graph
- `EnforcerAgent` — per-commit/per-PR validation agent
- `ViolationReport` — structured output: rule violated, files affected, suggested fix

**Deliverable:** `ws architecture check` — runs enforcer on the current state. `ws architecture init` — scaffolds `architecture-rules.ts` from existing project structure. `ws architecture report` — shows architectural health score over time.

---

## 8. Cross-Session Memory — The Project That Remembers

**Concept:** At the end of each session, the agent extracts a **learning summary** about the project: "this repo prefers `async/await` over callbacks", "auth is implemented via middleware, not decorators", "tests use `test()` function syntax, not `describe/it`". The next session loads these learnings into the system prompt, giving the agent project-specific context without manual setup.

**Why it matters:** Every AI coding assistant starts from scratch each session. There's no memory of project conventions, preferred patterns, or historical decisions. WrongStack's `director-session` and `director-state` infrastructure already have the concept of session checkpoints. Adding a **memory layer** on top is a natural extension.

**What's missing in competitors:** Claude Code, Codex, and Cursor have no cross-session memory. They learn within a session (via context window) but not across sessions.

**Implementation approach:** Extend `DirectorStateCheckpoint` with a `learnings: ProjectLearning[]` array:
```typescript
interface ProjectLearning {
  category: 'convention' | 'pattern' | 'constraint' | 'decision';
  statement: string;
  evidence: { file: string; line: number; snippet: string }[];
  confidence: 'high' | 'medium' | 'low';
  lastUpdated: string;
}
```
At session end, the Director runs a **Learning Extraction** pass: it analyzes what patterns were used, what constraints were encountered, and what decisions were made, then adds new learnings or updates existing ones. On startup, learnings are loaded and injected into `systemPromptBuilder`. Learnings are stored in `.wrongstack/learnings/<projectId>.json`.

**Key primitives:**
- `LearningExtractor` — end-of-session pattern and convention analysis
- `LearningStore` — persisted `.wrongstack/learnings/` directory
- `LearningMerger` — merges new learnings with existing ones, resolving conflicts
- `SystemPromptInjector` — loads learnings into the system prompt for the next session

**Deliverable:** `ws memory show` — displays current project learnings. `ws memory teach "<statement>"` — manually add a learning. `ws memory clear` — reset learnings for the project. The Director automatically extracts learnings at session end and loads them at session start.

---

## 9. Cost-Aware Intelligence — Budget as an Optimization Parameter

**Concept:** The agent doesn't just stop when `maxCostUsd` is reached. It makes every decision with cost awareness: "this refactor requires 3 agents, ~$0.40 total. Alternatively, a single-agent surface-level fix costs ~$0.08 but leaves 4× more technical debt. The $0.32 difference buys 4× debt reduction — here's the trade-off." Cost becomes a first-class decision variable, not a ceiling.

**Why it matters:** Current agents treat budget as a hard limit — stop when you hit it. This is the wrong model. Budget should be an optimization parameter: given a budget, maximize outcome quality. Given a desired outcome, minimize budget. WrongStack's `SubagentBudget` and `FleetUsageAggregator` already track costs per agent and per session. The step forward is making cost a **reasoning** input, not just a **monitoring** output.

**What's missing in competitors:** No AI coding assistant reasons about cost/benefit trade-offs. They either have no budget concept or treat it as a blunt ceiling.

**Implementation approach:** Introduce a `CostReasoner` module that, before every `spawn_subagent` call, evaluates alternatives:
```typescript
interface CostBenefitAnalysis {
  option: string;
  estimatedCost: number;       // USD
  expectedOutcome: string;
  qualityScore: number;         // 0-10
  costPerQualityPoint: number;
  alternativeTo: string | null;
}

async function analyzeOptions(task: Task): Promise<CostBenefitAnalysis[]> {
  // Generate alternative approaches and estimate cost/quality for each
}
```
The Fleet monitor gains a **live cost/benefit panel** showing the trade-off tree for the current task. The Director uses this analysis to make informed spawn decisions, presenting the trade-off to the user for significant decisions (>$0.10 delta) and deciding autonomously for smaller ones.

**Key primitives:**
- `CostModel` — per-agent cost estimation based on model, token count, iteration count
- `QualityScorer` — estimates outcome quality for a given approach (heuristic: scope, depth, coverage)
- `CostBenefitAnalyzer` — generates and scores alternative approaches
- `FleetCostMonitor` — live cost/benefit visualization in the fleet dashboard

**Deliverable:** `ws plan --cost-aware<task>` — shows cost/benefit analysis before spawning. `ws fleet cost` — live cost dashboard. `ws budget set <limit>` — configurable budget with automatic throttling. The Director shows a cost summary at session end: total spent, outcome quality, cost per quality point.

---

## 10. Proactive Anomaly Detection — The Agent That Watches Itself

**Concept:** The agent monitors its own behavior patterns and detects anomalies before they cause failures. "Over the last 10 iterations, my `grep` usage is up 40% and `read` is down — this suggests I'm context-switching excessively, possibly because my context window is fragmenting." Or: "`bash` success rate dropped from 90% to 45% — likely a permission or path issue." The agent alerts the Director, which takes corrective action.

**Why it matters:** Agent failures are currently discovered reactively — the user notices a bad output, a failed tool call, or a permission error. By the time the user notices, wasted iterations have occurred. Proactive anomaly detection catches behavioral drift early, enabling the Director to course-correct (switch strategy, reset context, spawn a helper agent) before the session degrades.

**What's missing in competitors:** No AI coding assistant monitors its own behavioral health. They don't detect context fragmentation, strategy drift, or tool call degradation.

**Implementation approach:** Implement a `BehavioralAnomalyDetector` that runs continuously in the Director:
1. **Baseline Profile** — For each agent, track a rolling window of behavioral metrics: tool call distribution (which tools, how often), error rate per tool, iteration velocity (iterations per minute), context utilization (token usage per iteration), decision latency (time between decision and first tool call).
2. **Deviation Detection** — On each new data point, compute distance from baseline using a simple statistical model (z-score for each metric). If any metric exceeds a threshold (configurable, default: z > 2), emit an anomaly event.
3. **Anomaly Classification** — Classify the anomaly type from the pattern: `context_fragmentation` (tool diversity increasing, `read` rate dropping), `permission_drift` (`bash` error rate increasing), `strategy_drift` (iteration velocity changing without outcome improvement), `competence_degradation` (error rate increasing across all tools).
4. **Director Response** — The Director subscribes to anomaly events and can respond: restart the agent with a tighter prompt, suggest context compaction, spawn a helper agent to investigate, or notify the user.

```typescript
interface AnomalyEvent {
  agentId: string;
  type: AnomalyType;
  severity: 'warning' | 'critical';
  description: string;
  metrics: Record<string, { baseline: number; current: number; zScore: number }>;
  suggestedAction: string;
  timestamp: number;
}
```

**Key primitives:**
- `BehavioralBaseline` — rolling window statistics per agent
- `DeviationDetector` — z-score based anomaly detection on behavioral metrics
- `AnomalyClassifier` — pattern-matches metric deltas to known anomaly types
- `AnomalyResponder` — Director-level response to anomaly events

**Deliverable:** `ws fleet health` — shows per-agent behavioral health scores. `ws anomaly history` — shows past anomalies and resolutions. The Director auto-generates anomaly alerts in the fleet monitor. Anomalies are also written to the audit log for post-session analysis.

---

## Cross-Cutting Themes

Several themes appear across multiple ideas and represent architectural principles WrongStack should embrace:

**Event sourcing as foundation.** Ideas 1, 2, and 10 all benefit from treating the fleet bus as an event stream first and a notification system second. WrongStack's existing `FleetBus` is the seed — investing in a robust, replayable event store pays dividends across the entire system.

**Agent-as-first-class-observer.** Ideas 3, 4, and 5 share a common principle: the agent is already in the right place (reading the code, understanding the imports, tracking changes). Stop asking it to do less and start leveraging that position for secondary concerns (contracts, instrumentation, dependency reasoning).

**Cost and quality as explicit variables.** Ideas 8 and 9 both push toward making implicit things explicit. Budget isn't a ceiling, it's a parameter. Project conventions aren't assumptions, they're extracted facts. This philosophy — making the implicit explicit — is WrongStack's defining architectural direction.

**Enforcement over suggestion.** Ideas 6 and7 show that WrongStack can go beyond "here's a suggestion" to "here's what will be blocked." This requires confidence in the underlying analysis, but when that confidence exists, blocking is strictly better than suggesting. Users ignore suggestions; they respond to blockers.

---

## Prioritization Signal

Not all ideas are equal. Here's a rough framework for sequencing:

| Idea | Differentiation | Implementation Cost | Infrastructure Readiness | 
|------|----------------|--------------------|------------------------| 
| 8. Cross-Session Memory | High | Low | High (checkpoint exists) |
| 6. Living Documentation | Medium | Medium | Medium (document tool exists) |
| 5. Dependency Reasoning | High | Medium | Medium (audit tool exists) |
| 9. Cost-Aware Intelligence | High | Medium | Medium (FleetUsageAggregator exists) |
| 10. Proactive Anomaly Detection | High | Medium | High (FleetBus exists) |
| 4. Zero-Cost Observability | Medium | Medium | Medium |
| 1. Collaborative Debugging | Very High | High | Low |
| 7. Architecture Enforcement | Medium | Medium | Medium (refactor-planner exists) |
| 2. Deterministic Replay | Very High | High | Medium |
| 3. Symbolic Contract Verification | Very High | Very High | Low |

**Recommended first wave:** 8 (low cost, high value, strong infra fit), 10 (high value, strong infra fit), 9 (high value, moderate cost). These three leverage existing infrastructure and deliver visible differentiation quickly.

**Recommended strategic investments:** 1 and 2. These are the hardest to replicate and the most differentiated. They require more infrastructure work but lock in capabilities that competitors cannot match without rebuilding from scratch.
