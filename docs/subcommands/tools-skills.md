# `wstack tools` / `wstack skills`

## `wstack tools`

Lists all registered tools with their owner package and declared permission.

```text
wstack tools
  read                         [@wrongstack/tools] auto
  write                        [@wrongstack/tools] confirm
  bash                         [@wrongstack/tools] confirm
  grep                         [@wrongstack/tools] auto
```

Columns: name, owner package, and permission level. The subcommand does not currently render mutability, description, or risk tier; use `/tools` in-session for mutability and tool help/source for deeper audits.

## `wstack skills`

Lists all available skills across all scopes.

```text
wstack skills
  api-design        (bundled)  Use when: REST API design, error codes, pagination
  bug-hunter        (bundled)  Use when: systematic bug and code smell detection
  acme-conventions  (project)  Use when: writing code in the acme-web repository
  my-skill          (user)     Use when: ...
```

Each entry shows name, scope (`bundled`, `project`, or `user`), and the trigger description.

## Code reference

- `packages/cli/src/subcommands/handlers/tools-skills.ts`
- `packages/core/src/registry/tool-registry.ts`
- `packages/core/src/execution/skill-loader.ts`
