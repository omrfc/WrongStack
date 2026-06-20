# Next — pending follow-ups

Parked items from the provider/tool execution-path review. Each is low
severity (none are correctness bugs on the happy path).

## Provider/tool execution path (packages/core/src/execution)

- [ ] **Replace `Math.random()` with `randomUUID()` for artifact filenames**
      in `tool-executor.ts` (large-output persistence path). `node:crypto` is
      already imported in the package. Cosmetic — removes the theoretical
      collision and makes filenames greppable/stable in tests. [LOW]

- [ ] **Add a cross-reference comment for the synthetic `599` status.**
      `retry-policy.ts:21` treats `status === 599` (stream hang) as a real
      retry case, but `599` is an internal sentinel raised by
      `core/streaming-response-builder.ts`. A one-line comment in each file
      pointing at the other keeps the implicit contract from drifting. [INFO]

- [ ] **(Optional) Reconsider the network-error retry budget.**
      `retry-policy.ts:13` gives raw network errors `attempt < 2` (2 tries)
      vs. 3 for `5xx`. Likely deliberate (a network error may mean the request
      never reached the provider → duplicate side-effect risk on
      non-idempotent calls), so confirm intent before changing. [INFO]

## Done this session (no action needed)

- [x] Abort-listener leak in the retry-delay wait — `core/provider-runner.ts`.
      Consolidated timer + listener teardown into a single `cleanup()` so the
      abort-wins and timer-wins branches can't drift; dropped redundant
      `{ once: true }`. Typecheck clean; execution-path tests 37/37 pass.

## Cross-session caveat (carry-over)

- `selective-compactor.ts` is committed-pending in this working tree but its
  `estimateMessages` import depends on another session's **uncommitted**
  `compaction-core.ts`. Do not commit `selective-compactor.ts` alone until
  `compaction-core.ts` lands on the remote, or the import will dangle.
