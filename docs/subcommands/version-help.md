# `wstack version` / `wstack help`

Small informational subcommands registered by the top-level CLI dispatcher.

## `wstack version`

Prints the WrongStack CLI version, API version, active Node.js version, and
platform.

```text
WrongStack <version> (apiVersion <apiVersion>, node <version>, <platform>)
```

## `wstack help`

Prints the compact top-level usage guide, including common commands and flags.
It is the same help surface users see when they ask for CLI usage from the
subcommand dispatcher.

## Code Reference

- `packages/cli/src/subcommands/handlers/version-help.ts`
- `packages/cli/src/version.ts`
