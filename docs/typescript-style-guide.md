import { toErrorMessage } from '@wrongstack/core/utils';
# WrongStack TypeScript Style Guide

Surgical guide for TypeScript patterns that are easy to get wrong in this
codebase. NOT a general TS tutorial — assumes you know the basics. Focus on
WrongStack-specific conventions and footguns.

---

## Discriminated unions + utility types

### `Omit` / `Pick` on unions → use distributive versions

The standard `Omit<T, K>` and `Pick<T, K>` collapse on discriminated unions
because `keyof Union` returns the **intersection** of all members' keys, not
the union.

```ts
// ❌ BROKEN — Omit<HistoryEntry, 'id'> collapses to {}
type Broken = Omit<HistoryEntry, 'id'>;

// ✅ Use DistributiveOmit from @wrongstack/core
type Fixed = DistributiveOmit<HistoryEntry, 'id'>;
```

**Where**: `import type { DistributiveOmit, DistributivePick } from '@wrongstack/core'`

**Why**: `Omit<T, K>` is `Pick<T, Exclude<keyof T, K>>`. When `T` is a union,
`keyof T` only includes keys present in **every** member. The distributive
versions force `Omit`/`Pick` to apply per-member via `T extends unknown`,
preserving the discriminated union structure.

**When to worry**: Any time `Omit` or `Pick`'s first argument could be a union
type. If it's always a single interface (like most function parameter types),
the standard utility is fine.

```ts
// ✅ Fine — Theme is a single type
type PartialTheme = Partial<Omit<Theme, 'version'>>;

// ⚠️ Suspicious — ResolveResult might be a union
type Slim = Omit<ResolveResult, 'id'>;
//                        ^^^ if this is a union, use DistributiveOmit
```

**The `K & keyof T` trick in `DistributivePick`**: Unlike `DistributiveOmit`,
`DistributivePick` uses `K & keyof T` as the pick constraint. This is
necessary because when distributing over a union, `K` might include keys
absent from some members (e.g., picking `name` from a `user` member that
has no `name`). The intersection constrains to per-member keys.

---

## `exactOptionalPropertyTypes`

WrongStack enables `exactOptionalPropertyTypes: true`. This means
`{ prop?: boolean }` does NOT accept `{ prop: boolean | undefined }`.
The `?` means the property can be **absent**, not that its value can be
`undefined`.

```tsx
// ❌ Compile error: dimColor is boolean | undefined, prop expects boolean
<Text dimColor={someOptionalBoolean} />

// ✅ Fallback to a concrete value
<Text dimColor={someOptionalBoolean ?? false} />
```

**Rule of thumb**: If a prop is optional (`?`) and your value might be
`undefined`, use `??` or an explicit conditional. Never pass `undefined`
to an optional prop expecting a concrete type.

---

## `as any` — trust boundaries only

Never use `as any` to silence a type error. If you MUST cross a trust
boundary (JSON parse, interop with untyped library), validate or narrow the
value with an assertion function before using it as a typed value.

```ts
// ❌ Silences the checker
const data = response.json() as any;

// ✅ Explicit trust boundary
const data = await response.json();
assertStatusResponse(data);
// data is StatusResponse here
```

---

## Exported functions — always annotate return type

```ts
// ❌ Return type inferred — hides errors at call sites
export function processEvent(ev: Event) {

// ✅ Explicit — errors surface at the source
export function processEvent(ev: Event): ProcessedEvent {
```

Exception: React components with `forwardRef` can omit when the inference is
trivially correct and the annotation would be noisy.

---

## Discriminated unions — exhaustive switches

Every switch on a discriminated union must cover all cases or have an
assertion in the default branch.

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`);
}

switch (entry.kind) {
  case 'user':       return renderUser(entry);
  case 'assistant':  return renderAssistant(entry);
  // ...all cases...
  default:           return assertNever(entry);
}
```

If a new union member is added, TypeScript flags the `default` branch
immediately — no silent fallthrough.

---

## `noUncheckedIndexedAccess`

Array/object access returns `T | undefined`. Always handle the `undefined`
case.

```ts
const first = items[0];           // string | undefined
const last = items.at(-1);        // string | undefined

// ✅ Guard before use
if (first !== undefined) {
  console.log(first.toUpperCase());
}

// ✅ .at() + nullish check
const last = items.at(-1);
if (last) process(last);
```

---

## Imports

- Always `node:` protocol for built-in modules
- Always `.js` extension in relative imports (ESM)
- Type imports use `import type` — keeps them out of the runtime bundle

```ts
import * as fs from 'node:fs/promises';
import { softColor } from './theme.js';
import type { HistoryEntry } from './types.js';
```

---

## Structured error logging

WrongStack uses structured JSON for all `console.warn` and `console.error` calls
in server-side code (Node.js packages: `core`, `cli`, `mcp`, `tools`, `providers`,
`runtime`, `telegram`, `server/` directories). Every log entry is a single-line
JSON object with a standard schema so logs are machine-queryable without
regex-parsing ad-hoc prefixes.

**Browser/client-side code** (React components in `webui/src/components/`,
`webui/src/hooks/`, `webui/src/lib/ws-client.ts`) follows browser DevTools
conventions instead: multi-argument `console.error('label:', err)` so the error
object is expandable and stack traces are interactive.

### Schema

```ts
console.warn(JSON.stringify({
  level: 'warn',          // 'warn' | 'error' | 'fatal'
  event: 'subsystem.action', // kebab_case, hierarchical (e.g. 'session_store.delete_failed')
  message: '...',         // human-readable description (Error.message when wrapping)
  timestamp: new Date().toISOString(),
  // ... domain-specific fields (sessionId, path, tool, etc.)
}));
```

Field conventions:
- **`level`**: `'warn'` for non-fatal anomalies, `'error'` for failures, `'fatal'` for errors immediately followed by `process.exit()`
- **`event`**: dot-separated, subsystem-prefixed (`session_store.delete_failed`, `webui.port_reassigned`, `mcp_server.handle_message_failed`)
- **`message`**: always `toErrorMessage(err)` when wrapping errors — never the raw error object
- **Domain fields**: include relevant context (`sessionId`, `path`, `tool`, `source`, `protocol`, `attempt`, etc.) as top-level keys

### Do

```ts
// ✅ Structured JSON with domain context
.catch((err) => {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'queue_store.read_failed',
    path: this.file,
    message: toErrorMessage(err),
    timestamp: new Date().toISOString(),
  }));
});

// ✅ Best-effort cleanup with Promise.allSettled + ENOENT filtering
const results = await Promise.allSettled([
  fsp.unlink(jsonlPath),
  fsp.unlink(summaryPath),
]);
for (const r of results) {
  if (r.status === 'rejected') {
    if ((r.reason as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.delete_failed',
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
        timestamp: new Date().toISOString(),
      }));
    }
  }
}
```

### Don't

```ts
// ❌ Ad-hoc string template — hard to query, no structure
console.warn(`[store] delete failed: ${err}`);

// ❌ Passing raw error as second argument — inconsistent output
console.warn('[store] delete failed:', err);

// ❌ String template with context buried in the message
console.warn(`[SecurityScanner] retry ${n} after ${ms}ms (status=${s}) — ${msg}`);
```

### Error wrapping

When catching and re-throwing errors, always wrap into the `WrongStackError`
hierarchy so callers can branch on `.code` instead of parsing messages:

```ts
import { toWrongStackError, PluginError, ERROR_CODES } from '../types/errors.js';

// ✅ Wrap unknown errors at trust boundaries
throw toWrongStackError(err);

// ✅ Wrap with domain-specific subclass and context
throw new PluginError({
  message: `Plugin dependency sort failed: ${msg}`,
  code: ERROR_CODES.PLUGIN_LOAD_FAILED,
  pluginName: '(topological sort)',
  context: { pluginCount: plugins.length },
  cause: err,
});
```

`toWrongStackError()` pass-throughs existing `WrongStackError` instances
unchanged and wraps raw `Error`s in `AgentError` with the original as `cause`.

### Lint guard

A pre-commit hook (`scripts/lint-console-logging.mjs`) blocks new ad-hoc
`console.warn`/`console.error` string literals at commit time. It scans
staged TypeScript files only (not the full codebase) so pre-existing debt
doesn't block unrelated commits.

```bash
# Full codebase audit (for finding remaining debt)
pnpm lint:console

# Pre-commit hook runs automatically on every commit:
#   node scripts/lint-console-logging.mjs --verbose
```

The guard allows:
- `console.warn(JSON.stringify({...}))` — structured
- `console.warn(err)` — variable (could be structured)
- `console.warn(myFunc(x))` — function call
- `console.warn(new Error('msg'))` — Error object
- Test files (`.test.ts`, `tests/` directories) — automatically excluded

It blocks:
- `console.warn("string literal")` and `console.warn('string literal')`
- `` console.warn(`template ${literal}`) ``
- `console.warn('prefix:', err)` — ad-hoc context

Override with `--force` in emergencies:
```bash
node scripts/lint-console-logging.mjs --force
```
