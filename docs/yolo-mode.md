# YOLO Mode

YOLO mode is WrongStack's broad auto-approval setting. When YOLO is on,
`DefaultPermissionPolicy` approves tool calls that were not blocked earlier by
explicit deny rules.

Current behavior:

- `--yolo` enables broad auto-approval.
- Clearly destructive calls are also auto-approved by default.
- `--confirm-destructive` opts back into prompts for clearly destructive calls
  while leaving YOLO enabled for everything else.
- `--yolo-destructive` and `--force-all-yolo` are accepted for compatibility,
  but they are not needed for broad YOLO behavior.

## Quick Reference

| Surface | How to use it |
|---|---|
| CLI flag | `wrongstack --yolo` |
| Destructive confirmation opt-in | `wrongstack --yolo --confirm-destructive` |
| Interactive prompt | Answer `Y` at the "YOLO mode?" prompt during boot; default is yes |
| Slash command | `/yolo`, `/yolo on`, `/yolo off`, `/yolo toggle` |
| Programmatic | `permissionPolicy.setYolo(true)` |

YOLO is off only when the user explicitly declines it at boot, persisted config
sets it off, or `/yolo off` is run.

## Permission Evaluation Order

Every tool call passes through `DefaultPermissionPolicy.evaluate()` before
execution. The first matching rule wins:

```text
1. Session soft deny          -> deny
2. Session soft allow         -> auto
3. Trust file deny pattern    -> deny
4. Tool default deny          -> deny
5. Trust file allow pattern   -> auto
6. Trust file auto flag       -> auto
7. YOLO                       -> auto
   - with confirmDestructive: clearly destructive calls prompt
8. Smart bypass (write+read)  -> auto
9. Tool default               -> auto for non-mutating auto tools
10. Confirm prompt / event    -> confirm
```

This means trust-file deny rules and `permission: 'deny'` still win over YOLO.

## Destructive Confirmation

`--confirm-destructive` activates the input-aware destructive gate while YOLO
is on. The policy checks:

- `bash` commands such as `rm -rf /`, `git reset --hard`, `DROP TABLE`, or
  pipe-to-shell installers.
- File mutation tools targeting paths outside the project root.
- Tools declared with `riskTier: 'destructive'`.

Without `--confirm-destructive`, those calls are auto-approved by YOLO unless a
deny rule blocks them earlier.

## Runtime Toggle

YOLO can be toggled during a REPL/TUI session:

```text
/yolo           show current status
/yolo on        enable YOLO
/yolo off       disable YOLO
/yolo toggle    flip current state
```

The slash command accepts these arguments:

| Argument | Effect |
|---|---|
| `on`, `enable`, `true`, `1` | Enable |
| `off`, `disable`, `false`, `0` | Disable |
| `toggle` | Flip |

## Source Values

Permission decisions can report these relevant sources:

| Source | Meaning |
|---|---|
| `yolo` | Auto-approved because YOLO mode is active |
| `yolo_destructive` | `--confirm-destructive` is active and the call needs approval |
| `trust` | Matched an allow rule or trust-file auto flag |
| `deny` | Explicitly denied by a pattern or tool declaration |
| `user` | User answered a permission prompt |
| `context` | Smart bypass, such as writing a file already read this session |
| `default` | Tool's own declared permission level |

## Session-Scoped Soft Rules

When the user answers a permission prompt, the policy can remember the answer
for the rest of the session:

| Answer | Effect |
|---|---|
| `y` | `allowOnce()` auto-approves this tool/pattern for the session |
| `n` | `denyOnce()` blocks this tool/pattern for the session |
| `a` | `trust()` writes a permanent allow rule to `trust.json` |
| `d` | `deny()` writes a permanent deny rule to `trust.json` |

These session maps are cleared when the trust file is reloaded.

## Security Notes

| Concern | Mitigation |
|---|---|
| Accidental destructive commands | Use `--confirm-destructive`; trust-file deny patterns are evaluated before YOLO |
| Project-boundary escape | With `--confirm-destructive`, outside-project file mutations prompt |
| YOLO left on unintentionally | TUI status and `/yolo` show the current state |
| Subagent privilege escalation | Subagents use `AutoApprovePermissionPolicy`, which denies dangerous capabilities, MCP tools, and legacy risky names by default |
| Trust file poisoning | Trust is per project at `~/.wrongstack/projects/<hash>/trust.json`; encrypted secrets are separate |

Example defensive trust rules:

```jsonc
// ~/.wrongstack/projects/<hash>/trust.json
{
  "bash": {
    "deny": [
      "rm -rf /*",
      "DROP TABLE*",
      "DELETE FROM*"
    ]
  },
  "write": {
    "deny": ["~/.ssh/*", "~/.gnupg/*", "/etc/*"]
  }
}
```

## Programmatic Usage

```ts
import { DefaultPermissionPolicy } from '@wrongstack/core';

const policy = new DefaultPermissionPolicy({
  trustFile: '/path/to/trust.json',
  yolo: true,
  confirmDestructive: true,
});

policy.setYolo(false);
policy.setConfirmDestructive(true);

const isYolo = policy.getYolo();
const destructiveGate = policy.getConfirmDestructive();
```

For subagents:

```ts
import { AutoApprovePermissionPolicy } from '@wrongstack/core';

const subagentPolicy = new AutoApprovePermissionPolicy();
```

## Code Reference

- `packages/core/src/security/permission-policy.ts`
- `packages/core/src/security/yolo-risk.ts`
- `packages/cli/src/arg-parser.ts`
- `packages/cli/src/slash-commands/yolo.ts`
