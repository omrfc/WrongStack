# /fallback

View or change the **cross-provider fallback chain** — the ordered list of
models the agent rotates to when the active model is rate-limited or overloaded
(HTTP **429 / 529 / 5xx**) and its own retries are exhausted.

This makes 429 storms recoverable without babysitting: after the primary model's
per-model retry policy gives up, the chain engages and the agent stays on the
working fallback while the primary is cooling down. Once the cooldown expires,
the primary is tried as a half-open probe; a successful probe restores it, while
another overload backs off again. The switch applies to the leader **and** every
subagent.

## Usage

```
/fallback                        Show the active chain + smart-default state
/fallback add <provider/model>   Append a model to the explicit chain
/fallback add <model>            Append a model on the leader provider
/fallback remove <n|ref>         Remove by 1-based index or exact reference
/fallback clear                  Empty the explicit chain
/fallback auto on|off            Toggle the auto-derived smart default
```

Model references use the same syntax as `fallbackModels` in config: a bare
model id (same provider), `provider/model`, or `provider model`.

## Smart default

When the explicit chain is **empty** and `auto` is **on** (the default), a chain
is derived automatically from your other keyed providers and their declared
`models`: same-provider alternatives first (same key, cheapest failover), then
cross-provider, always excluding the current leader model and capped at 4
entries. So if you have keys for more than one provider, 429 recovery works out
of the box with no setup.

Turn it off with `/fallback auto off` to use **only** an explicit
`fallbackModels` list.

## Persistence

Both the explicit chain (`fallbackModels`) and the toggle (`fallbackAuto`) are
written to `~/.wrongstack/config.json`. Changes take effect immediately — the
effective chain is recomputed on every turn, so there's no need to restart.
The WebUI Settings panel edits the same fields.

## Related

- `/setmodel` — change the leader model and the per-task model matrix.
- `--fallback-model <list>` — set the chain at launch from the CLI.
- The `provider.fallback` event fires on each hop (surfaced in the REPL/TUI and
  available to WebUI event plumbing).
