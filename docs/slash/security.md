# /security — Security diagnostics

Interactive security checks for the current project: dependency audit,
bug-hunter scan dispatch, and a secret-redaction dry run.

## Subcommands

| Command | Effect |
|---|---|
| `/security audit-deps` | Run `pnpm audit --json` in the project and print a severity summary (critical/high/moderate/low + total). |
| `/security scan` | Print dispatch instructions for a `bug-hunter` subagent scan of the cwd. |
| `/security redact-test` | Run `DefaultSecretScrubber` over a sample payload with known secret shapes and report exactly which fields were redacted. |
| `/security help` | Usage help (also the default with no subcommand). |

## audit-deps

Spawns `pnpm audit` with a 60 s timeout. A non-zero pnpm exit is normal when
vulnerabilities exist — the summary is parsed from the JSON output either
way.

## scan

Slash commands are a synchronous UI surface and cannot host a subagent
themselves, so `scan` prints how to dispatch the `bug-hunter` role from a
surface that can (CLI subcommand, a subagent session via `/collab`, or
HQ → Security → Run scan). Findings stream on the FleetBus as `bug.found`
events and land in the audit log.

## redact-test

Proves the log-redaction pipeline works end-to-end: the sample contains API
keys, tokens, connection strings with passwords, and bearer JWTs, plus
non-sensitive fields. The output lists each redacted field with its
before/after value and counts the fields that passed through unchanged. If
nothing is redacted, the scrubber is not wired correctly — that is called
out explicitly.

## Examples

```
/security audit-deps
/security redact-test
```

See also: `/audit` (side-effect trail), `docs/subcommands` for the
`security:scan` CLI path, SECURITY.md for the project's security policy.
