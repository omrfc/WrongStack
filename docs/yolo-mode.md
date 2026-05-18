# YOLO Mode

YOLO (*You Only Live Once*) mode is WrongStack's **auto-approve** setting that skips every permission prompt and lets the agent execute any tool call immediately. This document covers how it works, where it fits in the permission pipeline, how to enable/disable it, and the security trade-offs.

---

## Quick reference

| Surface | How to enable |
|---|---|
| CLI flag | `wrongstack --yolo` or `wrongstack --tui --yolo` |
| Interactive prompt | Answer **Y** at the "YOLO mode?" prompt during boot (default is Y) |
| Slash command | `/yolo on`, `/yolo off`, `/yolo toggle`, `/yolo` (status) |
| Programmatic | `permissionPolicy.setYolo(true)` on a `DefaultPermissionPolicy` instance |

YOLO is **off** only when the user explicitly declines it at the interactive prompt or runs `/yolo off`.

---

## How it works

### Permission evaluation pipeline

Every tool call passes through `DefaultPermissionPolicy.evaluate()` before execution. The evaluation is a priority chain — the first match wins:

```
 1. Session soft deny          → deny   (user pressed 'n' earlier this session)
 2. Session soft allow         → auto   (user pressed 'y' earlier this session)
 3. Trust file deny pattern    → deny   (trust.json deny[])
 4. Tool default deny          → deny   (tool.permission === 'deny')
 5. Trust file allow pattern   → auto   (trust.json allow[])
 6. Trust file auto flag       → auto   (trust.json auto: true)
 7. ★ YOLO                     → auto   (source: 'yolo')
 8. Smart bypass (write+read)  → auto   (file was already read this session)
 9. Tool default               → auto   (tool.permission === 'auto')
10. Confirm prompt / event     → confirm (CLI prompt or tool.confirm_needed event)
```

When YOLO is active, step 7 catches every tool call that wasn't already handled by trust rules or tool defaults. The `PermissionDecision.source` is set to `'yolo'` so the session log and observability layer can distinguish auto-approved calls from trust-approved ones.

### The `source` field

Every `PermissionDecision` carries a `source` discriminator:

```ts
type PermissionSource = 'default' | 'trust' | 'yolo' | 'user' | 'deny' | 'context';
```

- **`yolo`** — auto-approved because YOLO mode is active
- **`trust`** — matched a rule in `trust.json`
- **`user`** — the user answered a prompt (yes/no/always/deny)
- **`context`** — smart bypass (write tool after the file was already read)
- **`default`** — tool's own declared permission level
- **`deny`** — explicitly denied by a pattern or the tool declaration

---

## Runtime toggle

YOLO can be toggled mid-session without restarting:

```
/yolo           → shows current status
/yolo on        → enable (auto-approve everything)
/yolo off       → disable (restore permission prompts)
/yolo toggle    → flip the current state
```

The slash command calls `permissionPolicy.setYolo(state)` under the hood. The change is immediate — the next tool call respects the new setting.

Aliases accepted by `/yolo`:

| Argument | Effect |
|---|---|
| `on`, `enable`, `true`, `1` | Enable |
| `off`, `disable`, `false`, `0` | Disable |
| `toggle` | Flip |

---

## CLI boot flow

```
1. parseArgs(argv)         → flags.yolo = true if --yolo was passed
2. bootConfig(flags)       → config loaded (yolo not stored in config file)
3. runLaunchPrompts()      → if flags.yolo is undefined, ask "YOLO mode? [Y/n]"
                             default is YES (press Enter = YOLO on)
4. permissionPolicy = new DefaultPermissionPolicy({ yolo: resolvedYolo })
5. execute({ getYolo: () => policy.getYolo(), ... })
```

Key points:

- **`--yolo` is a session flag**, not persisted in `config.json`. Each launch decides independently.
- The interactive prompt defaults to **Y** — users must explicitly type `n` to disable YOLO.
- `--goal` mode does **not** force YOLO; the user's choice at the prompt is respected.

---

## Subagent permission model

Subagents (spawned by the Director or via `/spawn`) use a separate policy class:

```ts
class AutoApprovePermissionPolicy implements PermissionPolicy {
  async evaluate(tool: Tool): Promise<PermissionDecision> {
    if (tool.permission === 'deny') {
      return { permission: 'deny', source: 'default', reason: 'tool default deny' };
    }
    return { permission: 'auto', source: 'yolo' };
  }
}
```

This means:

- Subagents **always** auto-approve — they run non-interactively and cannot answer prompts.
- Tools declared with `permission: 'deny'` are still blocked (this is a capability override, not a deny-bypass).
- `trust()` / `deny()` / `allowOnce()` / `denyOnce()` are no-ops — subagent decisions are ephemeral and do not pollute the leader's trust file.
- The user implicitly authorized delegation when they started the leader session.

---

## Trust file interaction

YOLO and the trust file (`trust.json`) coexist. The trust file is evaluated **before** YOLO, so explicit deny rules always win:

```jsonc
// ~/.wrongstack/projects/<hash>/trust.json
{
  "bash": {
    "deny": ["rm -rf *"]      // ← always denied, even in YOLO mode
  },
  "write": {
    "allow": ["src/**"]       // ← auto-approved regardless of YOLO
  }
}
```

Priority summary:

| Scenario | Result |
|---|---|
| YOLO on + trust deny match | **deny** (trust wins) |
| YOLO on + trust allow match | **auto** (trust wins, source: 'trust') |
| YOLO on + no trust match | **auto** (source: 'yolo') |
| YOLO off + no trust match | **confirm** (prompt user) |

---

## Session-scoped soft rules

When the user answers a permission prompt (YOLO off):

| Answer | Effect |
|---|---|
| **y** (yes) | `allowOnce()` — auto-approve this tool+pattern for the rest of the session |
| **n** (no) | `denyOnce()` — block this tool+pattern for the rest of the session |
| **a** (always) | `trust()` — write to trust.json permanently |
| **d** (deny) | `deny()` — write deny rule to trust.json permanently |

These session-scoped maps (`sessionAllowed`, `sessionDenied`) are cleared on `reload()` (when the trust file is re-read).

---

## Observability

YOLO-approved calls are logged with `source: 'yolo'` in the session JSONL. This allows:

- **Audit**: filter `permission.decision` events where `source === 'yolo'` to see what was auto-approved.
- **Cost analysis**: YOLO calls bypass the human confirmation bottleneck, so they tend to accumulate faster — the token/cost chips in the TUI status bar reflect this in real time.
- **Post-hoc review**: the trust file + session log together give a complete picture of what was allowed and why.

---

## Security considerations

| Concern | Mitigation |
|---|---|
| Accidental destructive commands | Trust file deny patterns are evaluated **before** YOLO — add `"bash": { "deny": ["rm -rf *", "DROP TABLE*"] }` to trust.json |
| YOLO left on unintentionally | The TUI status bar shows `YOLO` when active; `/yolo` shows current state |
| Subagent privilege escalation | `AutoApprovePermissionPolicy` still honors `tool.permission === 'deny'` |
| Trust file poisoning | Trust file is per-project (`~/.wrongstack/projects/<hash>/trust.json`), AES-256-GCM encrypted secrets are separate |

### Recommended deny patterns for YOLO users

```jsonc
// ~/.wrongstack/projects/<hash>/trust.json
{
  "bash": {
    "deny": [
      "rm -rf /*",
      "DROP TABLE*",
      "DELETE FROM*",
      ":(){ :|:& };:"
    ]
  },
  "write": {
    "deny": ["~/.ssh/*", "~/.gnupg/*", "/etc/*"]
  }
}
```

---

## TUI integration

The TUI status bar reflects YOLO state. When active, the boot message shows:

```
  ▶ Launching in TUI mode (YOLO)
```

The `getYolo` callback is passed to the execution layer so the TUI can query the live state:

```ts
// In execution.ts
getYolo?: () => boolean;
```

---

## Programmatic usage

```ts
import { DefaultPermissionPolicy } from '@wrongstack/core';

const policy = new DefaultPermissionPolicy({
  trustFile: '/path/to/trust.json',
  yolo: true,  // start in YOLO mode
});

// Toggle at runtime
policy.setYolo(false);

// Query current state
const isYolo = policy.getYolo(); // false
```

For subagent contexts:

```ts
import { AutoApprovePermissionPolicy } from '@wrongstack/core';

const subagentPolicy = new AutoApprovePermissionPolicy();
// All non-deny tools are auto-approved; trust file is not consulted.
```

---

## Summary

YOLO mode is a convenience feature that removes the permission prompt bottleneck. It sits at priority level 7 in the evaluation chain — above tool defaults but below explicit trust/deny rules. It can be toggled at any time via `/yolo`, defaults to on at boot, and is always-on for subagents. Combine it with trust file deny patterns for a safe-yet-fast workflow.
