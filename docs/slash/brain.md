# /brain — The Global Brain (decision support, autonomy ceiling, status)

## What it does

Inspects and steers the session's **Brain** — the decision layer that sits
between the agents and the human. Every autonomous subsystem (Director,
AutoPhase orchestrator, Eternal engine, BrainMonitor) routes its blocking
decisions through one shared Brain instance, bound at
`TOKENS.BrainArbiter`.

```
/brain                  Status: autonomy ceiling + recent decisions
/brain status           Same
/brain risk <level>     Set the autonomy ceiling: off | low | medium | high | all
/brain ask <question>   Consult the Brain directly for a decision
```

## How the Brain decides — three tiers

1. **Policy** (`DefaultBrainArbiter`) — deterministic rules. Low-risk
   requests with a recommended option are answered instantly; safe
   fallbacks (`continue`/`deny`) resolve without any LLM call.
2. **LLM** (`createAutonomyBrain`) — when the policy would escalate and
   the request's risk is **within the live ceiling**, the LLM decision
   engine (risk gate → heuristics → LLM evaluation) gets a chance to
   answer. It always sees the live provider/model, so `/setmodel`
   switches apply immediately.
3. **Human** (`HumanEscalatingBrainArbiter` + `BrainDecisionQueue`) —
   anything left becomes an interactive prompt (TUI overlay / REPL).

## The autonomy ceiling (`/brain risk`)

| Level | Behaviour |
|-------|-----------|
| `off` | LLM tier disabled — everything the policy can't answer goes to you |
| `low` | LLM auto-decides only low-risk questions |
| `medium` | LLM auto-decides low + medium (default) |
| `high` | LLM auto-decides low + medium + high |
| `all` | LLM auto-decides everything, including critical |

The ceiling is read on **every** decision, so changes take effect
immediately — including for decisions already queued by background
engines.

## Self-activation (BrainMonitor)

The Brain doesn't just wait to be asked. `BrainMonitor` watches the live
EventBus for distress signals and engages the Brain proactively:

- **Tool-failure streak** — the same tool failing 3× consecutively
  (streak resets on success).
- **Error storm** — 4+ `error` events within a 60-second window.

When the Brain decides to intervene, a high-priority `steer` mail is sent
from `brain@<sessionTag>` to this session's leader
(`leader@<sessionTag>`); the mailbox loop injects it into the agent's
conversation before its next step. Every engagement — intervening or not —
emits a `brain.intervention` event and is rate-limited by a 120-second
per-signal cooldown.

Without an LLM tier (ceiling `off`, or no provider), the monitor degrades
safely: the policy resolves the `continue` fallback and the Brain observes
without interfering.

## Examples

```
/brain
/brain risk high
/brain ask should we keep retrying the flaky integration test or skip it?
```

## Events

| Event | When |
|-------|------|
| `brain.decision_answered` | Brain answered (policy or LLM tier) |
| `brain.decision_ask_human` | Brain escalated to the human |
| `brain.decision_denied` | Brain denied the request |
| `brain.intervention` | BrainMonitor engaged (with `intervened: true/false`) |

`/brain status` shows the last 20 of these for the session.

## Related

- `/autonomy` — the eternal engine consults the Brain instead of
  auto-stopping on brainstorm-DONE / failure-budget thresholds.
- `/mailbox` — where Brain steer messages land.
- `docs/slash/autophase.md` — phase orchestrator Brain consultations.
