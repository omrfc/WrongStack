# WrongStack — Ideas Backlog

> Speculative and aspirational ideas for the WrongStack project. Not all will be built — this is a living document for brainstorming.

---

## 🔮 Core Agent Improvements

### 1. Stateful Session Recovery
Persist full agent state (including pending tool calls, mid-stream LLM responses, and uncommitted changes) to disk on every iteration. On restart, replay from the last checkpoint instead of starting fresh. Useful for long-running autonomous sessions interrupted by crashes or machine sleep.

### 2. Deterministic Replay
Record every LLM API call (request + response) to a replay log. Add a `/replay <session-id>` command that re-runs the exact same sequence of tool calls against a frozen API response, making it possible to debug agent behavior without burning API credits.

### 3. Multi-Model Fallback Chains
Define per-task model chains (e.g., "use Claude 3.5 Sonnet for planning, switch to GPT-4o for code generation if cost exceeds $X"). The selector already has family/capability awareness — extend it to support conditional fallback with budget gates.

### 4. Cost-Aware Task Routing
Tag tasks or subtasks with cost budgets. The multi-agent coordinator could route cheaper, well-defined tasks (grep, read, edit) to a smaller/faster model while reserving expensive reasoning for a frontier model.

### 5. Incremental Spec Generation (SDD v2)
The current SDD flow generates a full spec upfront. Explore incremental spec updates — agent proposes a change to the spec, human approves, code follows. This mirrors test-driven development but for specs.

---

## 🛡️ Security & Trust

### 6. Secrets Policy Engine
Extend the existing `SecretVault` with declarative policies: "API keys may only be written to `.env` files", "never write credentials to source files", "flag any shell command that echoes a secret". A policy violation could halt the agent with a structured explain.

### 7. Tool Call Audit Trail
Every tool invocation gets a signed SHA-256 fingerprint stored in the session log. Fingerprints are chained (each entry includes the previous hash). This creates a tamper-evident audit log of every action the agent took.

### 8. Sandboxed Tool Execution
Run destructive or untrusted tools (bash, exec, write) inside a WASM sandbox (like Fastly's_EXEC or gVisor). The agent's capability to cause harm outside the sandbox is structurally limited, not just policy-limited.

### 9. Interactive Approval Modes
Beyond `/yolo` (approve all) and interactive confirmation, add a "suggest then pause" mode where the agent shows its next N tool calls, lets the user edit or cancel specific ones, then executes the approved set. Particularly useful for `rm`, `git push --force`, or network calls.

---

## 🌐 Observability & Debugging

### 10. Real-Time Token Budget Visualization
Show a live bar in the TUI status line: "tokens: 45k / 200k (22%)" with color coding — green (plenty left), yellow (50%+ used), red (over 80%). The compactor already tracks this; surface it proactively to the human.

### 11. Session Diff Viewer
After each iteration, diff the current state of modified files against the previous iteration's snapshot. Show a `git diff`-style summary in the TUI: "Iteration 14: +23 lines in src/foo.ts, -7 lines in tests/foo.test.ts". Makes the agent's reasoning over time traceable.

### 12. Flamegraph for Agent Iterations
Instrument the coordinator loop with OpenTelemetry spans: LLM call, tool planning, tool execution, compaction. Export a flamegraph showing where iteration time goes. Useful for diagnosing why a session is slow.

### 13. Collaborative Debugging — Persistent Sessions
Allow a human to join an active agent session via a WebSocket terminal (the webui already exists). The human can annotate tool calls, leave inline comments, and take temporary control to debug a specific issue — then hand control back to the agent.

### 14. Root Cause Analysis Tool
When a test fails or a build breaks, instead of blind re-planning, run a targeted investigation: search for recent relevant changes, check error patterns in logs, identify which file changed last. Present findings as a structured "incident report" before attempting a fix.

---

## 📦 Plugins & Extension Points

### 15. Plugin Marketplace
A `wrongstack plugin install <name>` command that fetches plugins from a manifest registry (e.g., a JSON file in a GitHub repo). Signed plugin manifests prevent supply-chain injection. Include an `apiVersion` compatibility check.

### 16. MCP Server Manager CLI
Improve the `/mcp` slash command with: `wrongstack mcp list` (show running servers), `wrongstack mcp stop <name>`, `wrongstack mcp logs <name>`. Currently the TUI has a panel but there's no standalone CLI access.

### 17. Cron-Like Scheduled Automation
Schedule a WrongStack goal to run on a cron expression: `wrongstack schedule "review prs daily" "0 9 * * *"` backed by the `@wrongstack/plugins/cron`. Combine with the goal store for persistence across restarts.

---

## 📝 Code Quality & Engineering

### 18. Auto-Bisect for Regressions
Given a known-breaking commit range, the agent can run a binary search: checkout midpoint, run tests, report result, repeat. The existing `worktree` primitive makes this feasible — create a temporary worktree per bisection step.

### 19. Test Coverage Guided Generation
After generating or modifying code, run the test suite with coverage. Identify uncovered branches, generate targeted test cases to cover them. Could be a post-iteration compaction step.

### 20. Semantic Change Categorization
Classify every file change by semantic type: "refactor" (no behavior change), "feature" (new capability), "bugfix" (behavior correction), "chore" (tooling only). Use this for auto-generated changelogs and release notes.

### 21. Dependency Risk Scanner
Run `npm audit` / `pnpm audit` automatically and flag vulnerabilities by severity + exploitability. Suggest `/fix` commands to update vulnerable deps. The existing audit tool is wired; integrate it proactively into the iteration loop.

### 22. LLM-Generated Commit Messages via Conventional Commits
Use a small, fast model (or heuristics) to suggest a commit message in Conventional Commits format (`feat:`, `fix:`, `chore:`) before every `git commit`. Let the human edit or approve before the commit finalizes.

---

## 🔧 Developer Experience

### 23. WrongStack Language Server (LSP)
A VSCode/Neovim extension that communicates with the running WrongStack instance via MCP. Show inline diagnostics from the agent's last analysis, provide "Ask WrongStack" code actions, display session state in the sidebar.

### 24. Session Branching
Like `git worktree` but for agent sessions: branch an active autonomous session into a "what-if" variant without disrupting the main run. Useful for exploring alternative approaches to a hard problem.

### 25. Interactive Todo Board
A `/board` command that renders the current goal + todos as a ASCII Kanban board in the terminal. Drag cards between columns (`backlog`, `in-progress`, `done`) with keyboard navigation. Reflects the agent's understanding of task state.

---

## 🚀 Autonomy & Autophase

### 26. Autonomous Rollback
If a series of changes causes test failures or build breaks and the agent's retry attempts exhaust, automatically roll back to the last known-good state. Flag the regression to the human instead of continuing to fail.

### 27. Learning from Human Corrections
When a human manually edits a file the agent created, record that delta. Over time, build a "human correction" dataset that could be used to fine-tune tool-use patterns or prompt the agent to prefer certain styles.

### 28. Goal Decomposition Explainer
Before executing a complex goal, show the human a tree view of how the agent plans to decompose it: "Goal → Phase 1: understand → Phase 2: plan → Phase 3: implement → Phase 4: test". Let the human approve or redirect before autonomous execution begins.

---

## 📊 Cloud & Collaboration

### 29. Shared Team Context
A team-shared memory layer: store cross-session learnings (e.g., "this codebase uses a custom linting rule") that all team members' sessions can query. Sync via the existing cloud-sync infrastructure.

### 30. Session Video Recording
Record a terminal session as a structured event stream (every keystroke, every tool output). Replay it in the webui with scrubbing. Useful for code reviews and onboarding.

---

## 🔒 Hardening & Production

### 31. Read-Only Mode Toggle
A `--read-only` flag that structurally prevents any write operations (no edit, write, bash, exec, git commit). The agent can still read, search, analyze, and plan — but cannot modify anything. Useful for pure audit or investigation sessions.

### 32. Resource Limits Enforcement
Hard per-session limits: max files modified, max disk writes in MB, max CPU time. Currently the agent relies on its own judgment; make these limits enforced by the runtime layer so a misbehaving agent cannot DoS the machine.

### 33. Graceful Degradation Under Load
If the machine is under heavy load (high CPU, low memory), the agent could automatically reduce its parallelism, skip non-critical tool calls, or pause autonomous iteration until resources free up. Detect via `os.loadavg()` or `os.freemem()`.
