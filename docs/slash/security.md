# /security - Security Scanner

## What it does

`/security` runs an LLM-powered security scan through `defaultOrchestrator.run()`. It detects the tech stack, runs targeted checks, and produces a report. The command is registered by the built-in `wstack-security` plugin and requires an active LLM provider in the current context.

## Subcommands

| Usage | Effect |
|---|---|
| `/security scan` | Full scan with standard depth |
| `/security scan --depth quick` | Faster scan |
| `/security scan --depth deep` | Deeper scan with more thorough checks |
| `/security scan --format html` | Output as HTML instead of markdown |
| `/security audit` | Dependency audit plus security scan |
| `/security report` | List saved reports |
| `/security report <id>` | View a specific report by number or id/date substring |

## How it works

1. **Tech stack detection** - probes the project for `package.json`, `Cargo.toml`, `go.mod`, and related files.
2. **LLM-driven analysis** - the orchestrator calls the active provider with a security skill prompt.
3. **Report generation** - markdown, JSON, or HTML output is saved to `security-reports/`.
4. **Report lookup** - stored reports are listed newest first.

## Code reference

- `packages/core/src/plugins/security-plugin.ts`
- `packages/core/src/security-scanner/slash-command.ts`
- `packages/core/src/security-scanner/`
- `packages/core/skills/security-scanner/SKILL.md`
- `packages/core/tests/security-scanner/slash-command.test.ts`
