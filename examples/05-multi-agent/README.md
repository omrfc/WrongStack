# 05 — Multi-Agent

Examples showing director fleet orchestration and subagent delegation.

## Basic fleet audit

```bash
wrongstack --director "audit packages/core for security issues"
```

The Director spawns specialized subagents (bug-hunter, security-scanner,
refactor-planner, audit-log) and coordinates their work.

## Goal mode

Lock the agent into relentless autonomous execution:

```bash
wrongstack --tui --goal "add comprehensive error handling to all tool implementations"
```

The agent works until verifiably done. Esc to redirect, Ctrl+C to bail.

## Custom subagent spawn

In-session:

```
/spawn --provider groq --model llama-3.3-70b --name reviewer --tools read,grep,edit
```

Then assign a task:

```
/spawn --name reviewer "review the authentication module for race conditions"
```

## Fleet management

```
/fleet status          # task progress per subagent
/fleet usage           # token + cost breakdown
/fleet log <id>        # compact transcript summary
/fleet log <id> raw    # full per-subagent JSONL dump
/fleet kill <id>       # stop a specific subagent
/fleet manifest        # full fleet snapshot
/fleet retry <id>      # respawn a failed subagent
```

## Steering mid-flight

Redirect the agent while it's working:

```
/steer focus only on the security-critical paths, skip tests
```

Or press **Esc** then type your new direction.

## Delegate tool (automatic)

The agent can delegate work to subagents automatically when it detects
parallelizable tasks. No explicit `--director` flag needed — the first
`delegate` call auto-promotes to director mode.

The agent decides when to delegate based on the system prompt's delegation
guide. You don't need to do anything special.

## Multi-provider fleet

Different subagents can use different providers:

```bash
wrongstack --director "compare the performance of this code using different approaches"
```

The Director may spawn:
- A fast model (Groq/Llama) for initial exploration
- A strong model (Claude/GPT-4) for deep analysis
- A cheap model for bulk operations

## Budget control

Subagent budgets are set by the orchestrator, not the user. But you can
influence behavior:

```
/goal "refactor auth module — use cheap models for file scanning, strong model for logic"
```

## Observability

```
/agents                # current fleet roster with status chips
```

The TUI shows:
- **LiveActivityStrip**: one line per running subagent (tool, elapsed, iterations)
- **FleetPanel**: full roster with status, tokens, cost
- **Chat**: agent text and lifecycle summaries only (no tool spam)
