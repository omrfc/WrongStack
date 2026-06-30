# /yolo - Auto-Approve Tool Calls

## What It Does

`/yolo on` calls `DefaultPermissionPolicy.setYolo(true)`. In the current
permission policy, YOLO auto-approves tool calls that were not blocked earlier
by a session soft-deny, trust-file deny rule, or `tool.permission === 'deny'`.

`--yolo-destructive` and `--force-all-yolo` are accepted for compatibility, but
they do not bypass destructive-operation confirmation.

## Usage

| Usage | Effect |
|---|---|
| `/yolo` | Show current YOLO status |
| `/yolo on` | Enable YOLO mode |
| `/yolo off` | Disable YOLO mode and restore permission prompts |
| `/yolo toggle` | Toggle current state |
| `/yolo destructive` | Show destructive gate status |

The command also accepts `enable`, `true`, `1`, `disable`, `false`, and `0`.

### /yolo destructive

When YOLO is enabled, `/yolo destructive` controls whether destructive
operations (file deletion, shell commands with destructive side effects) still
prompt for confirmation. The gate is always on; this command reports that
status.

## Security Model Interaction

YOLO does not bypass explicit denies. The policy still checks these before
YOLO approval:

1. Session soft-deny from an earlier "no" answer.
2. Trust-file deny patterns.
3. Tool-level `permission: 'deny'`.

YOLO also checks whether the input is clearly destructive. In that mode, risky
calls return
`source: 'yolo_destructive'` and prompt.

```typescript
// In YOLO mode:
bash({ command: 'echo hello' }) // auto, source: 'yolo'
bash({ command: 'rm -rf /' })   // confirm, source: 'yolo_destructive'
```

## CLI Flags

| Flag | Effect |
|---|---|
| `--yolo` | Enable YOLO mode at startup |
| `--confirm-destructive` | Deprecated; clearly destructive calls already prompt |
| `--yolo-destructive` | Deprecated compatibility flag |
| `--force-all-yolo` | Deprecated compatibility flag |

## Code Reference

- `packages/cli/src/slash-commands/yolo.ts`
- `packages/core/src/security/permission-policy.ts`
- `packages/core/src/security/yolo-risk.ts`
- `packages/core/src/types/tool.ts`
