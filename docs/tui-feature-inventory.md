# TUI Feature Inventory — WrongStack

Exhaustive list of all user-facing features in the TUI (`@wrongstack/tui`).
This document serves as the specification for WebUI feature parity.

Generated: 2026-06-09
Last updated: 2026-06-26

> **WebUI parity status (as of 2026-06-12):** Most TUI features are now implemented in the WebUI.
> The remaining gaps are: status bar depth (TUI has 3 lines, WebUI has 1), and the Unicode sub-cell
> context fill bar precision. See the summary table at the bottom for the full current status.

---

## 1. Status Bar (always visible, 3 lines + fleet detail line)

### Line 1 — Identity & State
| Chip | Content | Notes |
|------|---------|-------|
| WS version | `WS v1.2.3` | App version string |
| State | `● idle` / `● thinking…` / `● aborting…` / `● agents ▶N` | Rainbow wave animation when thinking; idle→agents transition when fleet runs |
| Provider/Model | `openai/gpt-4o` | Clickable (opens model picker); re-renders when model changes |
| Mode | `teach` / `brief` / `code reviewer` | Active agent mode label |
| YOLO | `⚠ YOLO` | Red, visible when yolo mode active |
| ∞ Autonomy | `∞ SUGGEST` / `∞ AUTO` / `∞ ETERNAL` / `∞ ETERNAL-PARALLEL` | Visible when autonomy mode ≠ off |
| Eternal stage | `◻ idle` / `▶ execute(task)` / `↩ reflect: success/failure` / `⬇ decompose` / `⇄ fanout: N` / `⏳ await: N` / `↩ aggregate: 3/5` / `💤 sleep Ns` / `⏸ paused` / `■ stopped` / `⚠ error: msg` | Appears only when eternal/parallel engine active |

### Line 2 — Context & Cost
| Chip | Content | Notes |
|------|---------|-------|
| Context bar | `████████░░░░ 67% 32k/200k` | Sub-cell-precise fill bar (Unicode 1/8 block characters); color: green<60%, yellow<75%, red≥75% |
| Cost | `$0.0423` | Session total cost |
| YOLO ⚠ | Repeat of line 1 YOLO | Shown when yolo active |
| ∞ Autonomous | Repeat of line 1 autonomy | Shown when autonomy active |

### Line 3 — Activity
| Chip | Content | Notes |
|------|---------|-------|
| Todos | `todos ⌛5 ☐3 ✓2` | Pending/inProgress/completed counts; clickable (opens F5/F6) |
| Plan | `plan ☐3 ▶1 ✓2` | From plan.json on disk; polled every 3s |
| Fleet | `⚡ 4 agents: ▶2 ○2 ✓1` | Running/idle/completed counts; hidden when no fleet |
| Brain | `🧠 ask_human source · summary…` | Brain decision state (ask_human/denied/approved/deciding) |
| Debug stream | `🐛 stream #42 · 512B · +200ms · 12.4KB` | Only when stream debug active |
| Enhance countdown | `⏳ auto-send in 5s` | Countdown for prompt refinement auto-send |
| Git | `branch:main +2 -1` | Branch name + staged changes; polled every 5s |
| Elapsed | `12:34` (MM:SS) | Session elapsed time |
| Indexing | `⚙ indexing 42/500` | Codebase indexing progress; hidden when idle |

### Fleet Detail Line (always rendered, hidden when no fleet)
| Per agent | `AGENT_NAME ▶ 12:34 · 42t · read` / `AGENT_NAME · 12:34 · 0t` | Name, status (▶ running / · idle), elapsed, tool calls, current tool, ⚡×N extensions |

### Status Bar Visibility Control
- `/statusline hide <item>`, `/statusline show <item>`, `/statusline reset`
- Hideable items: `todos`, `plan`, `fleet`, `git`, `elapsed`, `context`, `cost`

---

## 2. Overlays & Panels (keyboard-driven)

### Agents Monitor (Ctrl+G / F3)
- **Header**: `AGENTS · LIVE │ ▶3 ──────────────── done ✓5 · failed ✗1 · ↑↓ nav · Ctrl+G / F3 close`
- **Model mapping**: `models AgentName:provider/model ...` (first 4)
- **Token/Cost row**: `shown 8 45k↑ 12k↓ total $0.1234 (leader $0.0500 · fleet $0.0734) · 2 idle hidden`
- **Agent rows** (compact, one per line): ▶/↓ selection indicator, status icon, name, provider/model, L-iterations/tools, context bar (████░░░░ 67%), context cost, current tool (with ms), elapsed time, ⚡×extensions, cost
- **Selected agent detail** (expanded inline):
  - Activity sparkline (▁▃▅▇▆▄▂▁▃▅ — 12-bin 2s buckets)
  - Last completed tool (name, duration, ok/fail)
  - Provider/Model info
  - Cost breakdown (total $0.0234 · ctx $0.0100)
  - Live streaming output tail
  - Last message snippet
  - Budget warnings (⚡ iterations 48/50 — extending)
  - Failure reason (✗ Connection timeout)
- **Keyboard navigation**: ↑↓ arrows
- **Auto-prunes**: terminal agents >5min old; idle agents >60s old

### Fleet Monitor (Ctrl+F / F2)
- **Header**: `FLEET · ORCHESTRATION │ ▶3 ○2 ✓5 ✗1 · Ctrl+F / F2 to close`
- **Collab session banner**: session ID, 🐛N bugs, 📐N plans, ⚖️N evals, verdict (approve/needs_revision/reject), inline timeline (last 6 events)
- **Concurrency gauge**: `concurrency [████████░░░░] 3/4` with progress bar
- **Token/Cost**: `45k↑ 12k↓ $0.1234`
- **Per-agent table**: status icon, name (14ch), model (18ch), status (9ch), L/t·ctx (12ch), elapsed (8ch), cost
- **Timeline**: last 20 events with relative timestamps
- **Terminal agent pruning**: >5min old excluded; count shown

### Fleet Panel (always visible below status bar)
- **Summary line**: `⚡ Fleet │ 3 running · $0.0500 · collab(2b/1p/1e)` or `⚡ Fleet │ idle`
- **Leader row**: `● LEADER → waiting for agents` (collab) or `● LEADER → read` (current tool)
- **Running agents** (up to 5): `● AgentName → currentTool`
- **Overflow**: `+3: Agent1, Agent2, …` with first 2 names
- **Self-hides** when no fleet and no collab session

### Goal Panel (F9)
- **Goal text display**: raw and refined goal
- **Progress**: `progress 67%` with trend
- **Deliverables**: list with status
- **Last journal entry**: task + status
- **Live refresh**: on open + on 10s tick while open

### Worktree Panel (F8) + Worktree Monitor
- **Graph view**: DAG of branches/worktrees
- **Lanes view**: swim-lane layout
- **Per-handle**: branch, owner, status, insertions/deletions, files, conflicts
- **Live activity strip**: recent events with timestamps

### Todos Monitor (F5 panel, F6 overlay)
- **Full todos list**: id, content, status with counts
- **Compact panel**: progress rail (amber in-flight, green at 100%)
- **Status bar chip**: quick counts

### Process List Monitor
- **Table**: PID, command, tool, startedAt, status (running/exited/killed), protected
- **Kill**: `/kill <pid>`, `/killall`

### Queue Panel
- **Queue items**: title, priority, status, dependencies, type
- **Queue management**: `/queue add`, `/queue remove`, etc.

### Help Overlay (F1)
- **Keyboard shortcuts reference**: all F-keys and Ctrl+ combos

### Slash Menu
- **Searchable command list**: type `/` to open, filter matches
- **Selection**: ↑↓ arrows, Enter to execute

### Model Picker (Ctrl+M or click provider/model chip)
- **Two-step**: provider selection → model selection
- **Search**: filter models by name
- **Confirmation**: apply provider+model pair

### Autonomy Picker
- **Options**: off, suggest, auto, eternal, eternal-parallel
- **Compact mode**: inline chip
- **Full mode**: description per option

### Settings Picker (Ctrl+S)
- **Fields**: mode, autoProceedDelayMs, titleAnimation, yolo, streamFleet, chime, confirmExit, nextPrediction, feature toggles (MCP, Plugins, Memory, Skills, ModelsRegistry, Token Saving, filesystem access), tools (maxIterations, autoProceedMaxIterations, refine countdown, refine toggle/language, indexOnStart, thinkingWord display), model runtime (reasoning mode/effort/preserve, cache TTL), context (autoCompact, strategy, mode), fleet maxConcurrent, logLevel, auditLevel, debugStream, statuslineMode, configScope
- **Persistence**: global `~/.wrongstack/config.json` or project `<project>/.wrongstack/config.json`, matching the visible config-scope row.
- **Keyboard**: ↑/↓ changes the selected row; ←/→ changes only the selected row and autosaves.

### Checkpoint Timeline (rewind)
- **Checkpoint list**: index, iteration, timestamp, label, message count, tokens
- **Rewind**: select checkpoint → revert files + truncate history

### Confirm Prompt
- **Tool confirmation**: tool name, input, suggested pattern
- **Decisions**: yes / no / always / deny

### Esc Confirm Prompt
- **Exit confirmation**: shown on Ctrl+C during idle

### Enhance Panel
- **Refined prompt preview**: "did you mean this?" with auto-send countdown
- **Controls**: accept, edit, cancel

### Brain Decision Prompt
- **Decision display**: ask_human, deny, approve with source and summary

### Phase Monitor/Panel (F7)
- **Phase list**: phase name, status, progress
- **Task assignments**: agent → phase → task mapping
- **AutoPhase**: autonomous phase orchestration with timeline

---

## 3. Chat & Input

### History
- **Messages**: user (green), assistant (white), tool results (collapsed groups)
- **Code blocks**: syntax highlighted (via highlight.js), line numbers
- **Markdown rendering**: tables, lists, headings, bold/italic
- **New message animation**: smooth appearance

### Input
- **Prompt**: `› ` prefix
- **Multiline**: Shift+Enter for newline
- **Paste handling**: bracketed-paste support, large-paste confirmation
- **Input history**: ↑↓ for history navigation
- **Inline tokens**: attachment placeholders `[pasted #1, 123 lines]`
- **Auto-scroll**: scrollback with "jump to latest" button

### Banner (startup)
- **Info**: version, provider, model, cwd, family, key tail

---

## 4. Context Management

### Context Fill Indicator
- **Visual bar**: colored progress bar with sub-cell precision
- **Token display**: `<used>/<max>` with formatted numbers (k/M)
- **Percentage**: relative to model's max context window
- **Real-time**: updates on every agent run completion

### Context Operations (via slash commands)
- `/clear` or Ctrl+L: clear chat history
- `/compact`: trigger context compaction
- `/context mode <id>`: switch context policy (balanced/frugal/deep/archival)
- `/context debug`: show context breakdown (system/tools/messages)
- `/context repair`: repair orphan tool_use/tool_result pairs

### Context Settings (in Settings Picker)
- `contextAutoCompact`: enable/disable auto compaction
- `contextStrategy`: hybrid/aggressive/conservative
- `maxIterations`: max agent iterations before auto-stop

### Context Modes
- **Presets**: balanced, frugal, deep, archival
- **Each mode has**: warn/soft/hard thresholds, preserveK (recent messages), eliseThreshold

---

## 5. Agents & Fleet Monitoring

### FleetBus Events (real-time)
- `spawned`: new subagent created
- `task_started`: subagent assigned work
- `tool_executed`: per-tool result (name, ok, duration)
- `iteration_summary`: periodic snapshot (iteration, tools, cost, current tool, partial text)
- `budget_extended`: self-extension event
- `ctx_pct`: context window fill update
- `task_completed`: final result (status, iterations, tools, error, final text)

### Fleet State
- **Per-agent**: id, name, status, provider, model, iterations, toolCalls, cost, currentTool, lastTool, ctxPct, ctxTokens, ctxMaxTokens, extensions, error, startedAt, lastEventAt, budgetWarning, failureReason, streamingText, recentTools, recentMessages
- **Fleet totals**: running/idle/completed counts, total cost, total tokens
- **Leader tracking**: iterations, toolCalls, recentTools, currentTool, startedAt, lastEventAt, iterating flag

### Per-Agent Detail (Agents Monitor)
- Sparkline (12-bin activity histogram)
- Last tool (name, duration, success flag)
- Provider/Model info
- Cost breakdown (total + context)
- Live streaming text tail
- Latest message snippet
- Budget warnings with limits used
- Failure reason

### Fleet Dashboard (Fleet Monitor)
- Concurrency gauge against max
- Agent table (compact)
- Event timeline (spawned, completed, budget events)
- Collab session details (when active)
- Terminal agent pruning with notice

---

## 6. Session Management

### Session Commands
- `/session resume <id>`: restore previous session
- `/session new`: start fresh session
- `/session save`: force-save current session
- `/session delete <id>`: delete archived session
- `/session list`: list saved sessions

### Checkpoint Timeline
- Visual timeline of checkpoints
- Rewind to any checkpoint (reverts files + truncates messages)

---

## 7. Additional Features

### File Search
- `/find <pattern>`: search project files
- Results in scrollable picker

### Git Integration
- Branch display in status bar
- Change counts (+N -M)
- `/worktree` commands for parallel branches

### Codebase Indexing
- Background indexing with progress indicator
- `/codebase-reindex` to force rebuild
- Status bar shows progress: `⚙ indexing 42/500`

### Process Management
- `/ps` to list running processes
- `/kill <pid>` to terminate
- `/killall` for mass termination

### Keyboard Shortcuts
- F1: Help
- F2: Fleet Monitor
- F3: Agents Monitor
- F5: Todos Panel
- F6: Todos Overlay
- F7: Phase Panel
- F8: Worktree Panel
- F9: Goal Panel
- Ctrl+C: Abort/Exit
- Ctrl+L: Clear history
- Ctrl+F: Fleet Monitor
- Ctrl+G: Agents Monitor
- Ctrl+S: Settings
- Ctrl+M: Model Picker
- ↑↓: Navigate history/menus
- Tab: Autocomplete

---

## Summary of TUI Capabilities for WebUI Parity Check

| Capability | TUI Has | WebUI Status |
|---|---|---|
| Status bar (3 lines) | ✅ | ⚠️ Partial (1-line header + sub-bar) |
| Context fill bar (visual) | ✅ | ⚠️ Text + progress bar, Unicode sub-cell bar pending |
| Context mode management | ✅ (via /) | ✅ Dropdown picker + wrench ops menu |
| Context operations (clear/compact/repair/debug) | ✅ | ✅ Ops dropdown in ContextModePicker |
| Agents Monitor (full overlay) | ✅ | ✅ `AgentsMonitor.tsx` — sparklines, streaming tail, tool log, budget warnings |
| Fleet Monitor (dashboard) | ✅ | ✅ `FleetMonitor.tsx` — table, sparklines, context bars, token aggregation, timeline |
| Per-agent context bars | ✅ | ✅ Visual progress bars in FleetMonitor + FleetPanel |
| Per-agent sparklines | ✅ | ✅ `SparklineChart` in FleetMonitor + FleetPanel |
| Per-agent budget warnings | ✅ | ✅ Derived from `ctx_pct >= 80%`; rendered in all fleet components |
| Per-agent failure reasons | ✅ | ✅ Rendered in FleetMonitor + FleetPanel |
| Per-agent streaming tail | ✅ | ✅ In `AgentsMonitor` + `FleetPanel` AgentDetail |
| Per-agent tool log | ✅ | ✅ In `AgentsMonitor` + `FleetPanel` AgentDetail |
| Fleet-wide token aggregation | ✅ | ✅ `fleetTokensIn/Out` in store, shown in FleetMonitor header |
| Fleet concurrency gauge | ✅ | ✅ `ConcurrencyGauge` + `fleet.concurrency_update` event wired |
| Fleet event timeline | ✅ | ✅ `EventTimeline` component in FleetMonitor |
| Leader tracking | ✅ | ✅ End-to-end: server → ws-handler → fleet store → UI crown badge |
| Keyboard navigation (agents) | ✅ | ✅ ↑↓ arrows in FleetMonitor + AgentsMonitor |
| Agent selection + detail | ✅ | ✅ Click + keyboard in both monitors |
| Keyboard shortcuts | ✅ | ✅ |
| Goal panel | ✅ | ✅ |
| Phase panel/monitor | ✅ | ✅ |
| Worktree panel/monitor | ✅ | ✅ |
| Todos panel | ✅ | ✅ |
| Process monitor | ✅ | ✅ |
| Checkpoint timeline | ✅ | ✅ |
| Model picker | ✅ | ✅ |
| Autonomy picker | ✅ | ✅ |
| Settings picker | ✅ | ✅ (separate page) |
| Slash menu | ✅ | ✅ (command palette) |
| Chat history | ✅ | ✅ |
| Code blocks | ✅ | ✅ |
| Input | ✅ | ✅ |
| Session management | ✅ | ✅ |
| File explorer | N/A | ✅ |
| Code editor | N/A | ✅ |
| Collab panel | N/A | ✅ |
