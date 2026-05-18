# WrongStack Examples

Working examples organized by complexity. Each directory contains a focused
demonstration of one WrongStack capability.

## Quick start

```bash
# Run any example
wrongstack "$(cat examples/01-basic/single-shot.md)"

# Or paste the prompt interactively
wrongstack --tui
```

## Index

| # | Example | What it demonstrates |
|---|---------|---------------------|
| 01 | [Basic usage](01-basic/) | Single-shot, REPL, session resume |
| 02 | [Tool usage](02-tools/) | File editing, code search, git operations |
| 03 | [Multi-provider](03-providers/) | Switching providers, custom endpoints |
| 04 | [MCP integration](04-mcp/) | Connecting MCP servers, using MCP tools |
| 05 | [Multi-agent](05-multi-agent/) | Director fleet, delegation, subagents |
| 06 | [Real-world workflows](06-real-world/) | Refactoring, testing, debugging, audits |

## Running with flags

```bash
# TUI + YOLO for fast iteration
wrongstack --tui --yolo "$(cat examples/01-basic/single-shot.md)"

# Specific provider
wrongstack --provider groq --model llama-3.3-70b-versatile "$(cat examples/02-tools/code-search.md)"

# Director mode for multi-agent examples
wrongstack --director "$(cat examples/05-multi-agent/fleet-audit.md)"
```
