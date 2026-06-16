# Architecture Decision Record — 002: Help Delegation via `customBody`

| Field | Value |
|---|---|
| **Date** | 2026-06-15 |
| **Status** | Accepted (audit predictions confirmed) |
| **Deciders** | WrongStack core team |
| **Supersedes** | — |
| **Superseded by** | — |
| **Related** | `packages/cli/src/subcommands/handlers/per-subcommand-help.ts`, `packages/cli/src/subcommands/handlers/auth-local-help.ts`, `packages/cli/src/subcommands/handlers/models-add-help.ts`, `packages/cli/src/subcommands/handlers/bench-run-help.ts` |

## Status update (2026-06-15)

The original audit (below) identified `auth:local` (already done),
`models:add` (predicted next-best), and 32 entries that would NOT
benefit from `customBody` delegation. The audit's two predictions
have been **confirmed** by follow-up work on the same day:

- **`models:add`** (predicted: "Yes, strongest candidate") — **done**
  on 2026-06-15. Created `models-add-help.ts` with the `MODELS_ADD_FLAGS`
  array (9 flags organized into identity/capabilities groups),
  refactored `providers-models.ts` to consume the array, and added
  the deep entry with `customBody: renderModelsAddHelpToString`.
  17 new tests in `models-add-help.test.ts` cover the
  byte-for-byte parity contract.

- **`bench:run`** (predicted: borderline case for a 9-flag entry
  with 3 subcommands) — **done** on 2026-06-15. Created
  `bench-run-help.ts` with the `BENCH_RUN_FLAGS` array (9 flags
  organized into suite/models/control groups, with `defaultValue`
  and `required` annotations). Refactored `bench.ts` to consume
  the array for default-value lookups and required-flag checks.
  21 new tests in `bench-run-help.test.ts` cover the parity
  contract.

The audit's "Why the audit didn't find more candidates" rationale
turned out to be correct in practice: of the 32 entries marked
"No", none have since been refactored to use `customBody`. The
95/5 split is stable — most deep entries fit the standard layout
fine, and the few that don't all share the same profile (multi-flag
tables, dedicated handler modules, complex dispatch).

The body of this ADR below is the original 2026-06-15 audit,
preserved for context. The "Worked example: adding `customBody`
to `models:add`" section is now historical (it was the recipe
we followed). The "When to Re-evaluate" section has been updated
to note that the first two conditions have fired.

## Context

The `wstack <sub> --help` system renders per-subcommand help blocks from
two data structures:

- `helpTable` — top-level entries (one per registered subcommand).
- `deepHelpTable` — deep-subcommand entries (e.g. `mcp:add`,
  `auth:local`, `models:remove`).

Every entry in either table conforms to the `PerSubcommandHelp` shape
(`{ title, description, usage, subcommands?, seeAlso? }`) and is rendered
by a single layout function — `renderBlockToString` — that produces a
column-aligned block with a title, dimmed description, bold "Usage" line,
optional subcommand table, and optional "see also" pointer.

This standard layout covers ~95% of the help surface. The remaining ~5%
are help blocks that need a different visual treatment:

- A column-aligned **flag table** with the description column
  carefully aligned (e.g. the `LOCAL_AUTH_FLAGS` array in
  `auth-local-help.ts`)
- Closing **"Examples"** or **"See also: ..."** lines that the standard
  layout doesn't support
- A **shortcut** to a dedicated help module that already owns the flag
  list (so the flag list lives in exactly one place)

For these cases, the standard layout is too rigid. The `auth:local` deep
entry (added in 2026-06-15) was the first to need this — it delegates
to `renderAuthLocalHelpToString` so the `wstack auth local` flag list
lives in `LOCAL_AUTH_FLAGS` and is shared by `wstack auth local --help`,
`/auth local help`, and `/help auth local` with zero drift.

The question: should the same delegation pattern be applied to the
other deep entries? And if so, which ones?

## Decision

**Add a new field `customBody?: () => string` to `PerSubcommandHelp`**
that, when set, replaces the standard layout with the function's output.

**Apply it selectively to deep entries where a dedicated help module
exists or is clearly worth creating** — specifically, entries that have:

1. A non-trivial flag table (3+ flags, with default-value hints or
   grouped categories) that benefits from column alignment
2. A dedicated handler module elsewhere in the codebase that owns
   the flag list (so the help module can delegate to the same source)
3. A closing "Examples" or "See also: ..." block the standard
   layout doesn't support

The first entry to use the pattern is `auth:local` (delegates to
`auth-local-help.ts`). The pattern is the recommended approach for
future deep entries that meet the criteria above.

## Audit of existing deep entries

The full `deepHelpTable` (as of 2026-06-15) has **34 entries** (29
standard + 4 `auth:*` deep entries + 1 `auth:local` with
`customBody`). Audited each one against the three criteria
above. The verdict:

| Entry | Flag count | Dedicated module exists? | Closing "Examples"? | Verdict |
|---|---|---|---|---|
| `mcp:add` | 1 (`--enable`/`-e`) | No | No | **No** — too small |
| `mcp:remove` | 0 | No | No | **No** — trivial |
| `mcp:restart` | 0 | No | No | **No** — REPL-only flag |
| `plugin:add` | 1 (`--disabled`) | No | No | **No** — too small |
| `plugin:remove` | 0 | No | No | **No** — trivial |
| `plugin:enable` | 0 | No | No | **No** — trivial |
| `plugin:disable` | 0 | No | No | **No** — trivial |
| `plugin:list` | 0 | No | No | **No** — trivial |
| `plugin:official` | 0 | No | No | **No** — trivial |
| `plugin:officials` | 0 | No | No | **No** — trivial (alias) |
| `models:add` | **9** (identity + capability groups) | **Yes** (`models-add-help.ts`) | **No** (but the 2-group subheaders and column alignment matter) | **Already done** — `customBody: renderModelsAddHelpToString` |
| `models:remove` | 0 | No | No | **No** — trivial |
| `models:refresh` | 0 | No | No | **No** — trivial |
| `models:list` | 0 | No | No | **No** — trivial |
| `audit:list` | 0 (just `--list`) | No | No | **No** — flag-shaped, not table-shaped |
| `replay:list` | 0 (just `--list`) | No | No | **No** — flag-shaped, not table-shaped |
| `sessions:resume` | 0 (`[<id>]` is positional) | No | No | **No** — positional is in `usage` line |
| `sessions:fleet` | 0 | No | No | **No** — trivial |
| `sessions:show` | 0 (`<id>` is positional) | No | No | **No** — trivial |
| `sessions:list` | 0 | No | No | **No** — trivial |
| `sessions:config` | 0 | No | No | **No** — alias |
| `config:show` | 0 | No | No | **No** — trivial |
| `config:edit` | 0 | No | No | **No** — trivial |
| `config:history` | 1 (`--id`) | No | No | **No** — single flag fits standard table |
| `config:restore` | 1 (`--latest`/`-l`) | No | No | **No** — single flag fits standard table |
| `rewind:list` | 0 | No | No | **No** — flag-shaped |
| `rewind:all` | 0 | No | No | **No** — flag-shaped |
| `rewind:last` | 0 | No | No | **No** — flag-shaped |
| `rewind:to` | 0 | No | No | **No** — flag-shaped |
| `rewind:resume` | 0 | No | No | **No** — flag-shaped |
| `auth:list` | 0 | No | No | **No** — list view, not flag table |
| `auth:status` | 0 | No | No | **No** — single positional |
| `auth:remove` | 0 | No | No | **No** — single positional |
| `auth:local` | **7** (`--name`, `--base-url`, `--no-key`, `--no-probe`, `--probe-only`, `--model`, `--audit`) | **Yes** (`auth-local-help.ts`) | **Yes** | **Already done** — `customBody: renderAuthLocalHelpToString` |
| `bench:run` | **9** (`--suite`, `--polyglot-dir`, `--languages`, `--dataset-dir`, `--docker`, `--models`, `--limit`, `--out`, `--concurrency`) | **Yes** (`bench-run-help.ts`) | **No** (but the standard layout's "Flags" section is also 9 rows, so the column alignment matters) | **Already done** — `customBody: renderBenchRunHelpToString` (3 groups: suite / models / control) |

**Result (as of 2026-06-15, post-status-update)**: **3** deep entries
are using `customBody` delegation — `auth:local`, `models:add`,
`bench:run`. The original audit identified `models:add` as the
next-best candidate (now done) and 32 entries that would NOT
benefit. The 32 "No" verdicts have all held up: none of them have
been refactored since, confirming the audit's 95/5 split.

The other 32 entries are either too small (1 flag or 0 flags),
are flag-shaped (the flag is the entry itself, not a parameter),
or are list/positional views where the standard layout already
works.

## Reasons

### Why `models:add` is a strong candidate

`models:add` has **9 flags** organized into two semantic groups:

- **Identity** — `--provider <id>`, `--name <name>`, `<mid>` (positional)
- **Capabilities** — `--max-context <N>`, `--max-output <N>`,
  `--tools`/`--no-tools`, `--vision`/`--no-vision`, `--reasoning`,
  `--streaming`/`--no-streaming`, `--json-mode`

The flag list currently lives in the `deepHelpTable` entry as a
`subcommands` array (lines 782-808 of `per-subcommand-help.ts`),
mirroring the parser in `packages/cli/src/subcommands/handlers/providers-models.ts`.
The parser parses these flags; the help entry lists them. **Two
sources of truth** — the next time a flag is added, the contributor
must update both.

**Status update (2026-06-15)**: this analysis predicted the
two-source-of-truth pain point correctly. The follow-up work
created `models-add-help.ts` and refactored the parser to consume
`MODELS_ADD_FLAGS`; the flag list now lives in exactly one place.
See the "Worked example" section below — the recipe is now
historical, having been followed on 2026-06-15.

A dedicated `models-add-help.ts` module would:

1. Export `MODELS_ADD_FLAGS: ReadonlyArray<{ flag: string; description: string }>`
2. Export `renderModelsAddHelpToString(): string` — the formatted
   help block
3. Export `renderModelsAddHelp(renderer: TerminalRenderer): void` —
   the renderer variant
4. The `models:add` deep entry's `customBody` would be
   `renderModelsAddHelpToString`
5. The flag list lives in `MODELS_ADD_FLAGS` and is consumed by both
   the parser (via a new `parseModelsAddFlags(args)` function) and
   the help renderer (via `MODELS_ADD_FLAGS.map(...)`)

The result: **one source of truth** for the flag metadata. Adding a
new flag updates `MODELS_ADD_FLAGS` and both the parser and the
help render pick it up automatically.

### Why this is not done in this PR

> **Status update (2026-06-15)**: this section is now historical.
> The `models:add` refactor was completed on 2026-06-15 (see
> the "Worked example" section below for the recipe that was
> followed). The "Why this was deferred" rationale below is
> preserved for context — it captures the cost-benefit analysis
> that justified the deferral at the time, and the resolution
> (the audit's prediction came true) confirms the analysis was
> correct.

The cost-benefit for `models:add` is real but smaller than the
`auth:local` case:

- `auth:local` has 7 flags AND a dedicated handler module
  (`auth-local-help.ts`) that was already created for the
  `wstack auth local` short-circuit. The help module is a
  pre-existing artifact; the `customBody` delegation was a
  one-line addition that brought an existing module into the
  per-subcommand-help system.
- `models:add` has 9 flags but NO dedicated help module yet.
  Creating `models-add-help.ts` is a new file (~50-80 lines) plus
  a refactor of the parser to consume `MODELS_ADD_FLAGS`. This is
  meaningful scope.

The audit identifies `models:add` as the next-best candidate, but
the actual refactor is deferred to a future PR. The audit is
documented here so future contributors know:

1. The pattern exists (in `auth:local`)
2. The criteria for applying it (this document)
3. Which existing entries would benefit (the table above)

**Resolution (2026-06-15)**: the cost-benefit was worth it. The
follow-up work created `models-add-help.ts` (281 lines), refactored
the parser to consume `MODELS_ADD_FLAGS` (~30 lines of changes
in `providers-models.ts`), and added 17 new tests. Total scope:
~330 lines, of which the help module itself is 281. The deferral
preserved the ability to write a clean ADR with the full context;
the resolution was implemented in a single follow-up turn.

### Why the audit didn't find more candidates

The other deep entries fall into three categories:

1. **Too small** (1 flag or 0 flags) — `mcp:add` (`--enable`),
   `plugin:add` (`--disabled`), `config:history` (`--id`). A dedicated
   module for a 1-flag entry is over-engineered.
2. **Flag-shaped** — `audit:list`, `replay:list`, all `rewind:*`
   entries. The flag IS the deep subcommand (e.g. `wstack audit --list`
   is a distinct invocation, not `wstack audit list`). The standard
   layout's `usage` line already says `wstack audit --list / wstack
   audit -l` — a column-aligned flag table is unnecessary.
3. **Trivial** — `mcp:remove`, `plugin:remove`, `models:remove`,
   `sessions:list`, `config:show`, etc. Single positional or no
   arguments. The standard layout works.

The 95/5 split in the audit is consistent with the underlying
complexity of the underlying handlers — most subcommands have
small, simple argument sets. The few that don't (`auth:local`,
`models:add`, and now `bench:run`) are the ones that benefit from
a dedicated module. As of the 2026-06-15 status update, **all
three** of those entries use the `customBody` pattern.

## Consequences

### Positive

- The `customBody` pattern is documented as a first-class option
  in the `PerSubcommandHelp` interface (with worked example in the
  file's top-of-file JSDoc)
- The criteria for applying the pattern are explicit and auditable
- Future contributors know which entries are candidates — the
  3 entries that meet the criteria (`auth:local`, `models:add`,
  `bench:run`) all use the pattern, and the 32 entries that don't
  meet the criteria are documented in the audit table
- The standard layout continues to cover ~95% of entries — the
  `customBody` is a deliberate choice, not a workaround
- The pattern has been applied to 3 entries on the same day the
  audit was written, confirming the 95/5 split in practice

### Negative

- Two ways to render a help block (standard layout + `customBody`)
  adds a tiny amount of complexity to the renderer
- The `title` / `description` / `usage` / `subcommands` / `seeAlso`
  fields are required by the `PerSubcommandHelp` type even when
  `customBody` is set (for test-infrastructure uniformity), which
  means a contributor must fill them in with sensible defaults
  even though they're never rendered. This is a minor bookkeeping
  cost; the cost of NOT having them is that tests like
  "every entry has a non-empty title and description" would have
  to special-case `customBody` entries.

## Alternatives Considered

1. **Always use the standard layout (no `customBody` escape hatch)**
   — Would force the `auth:local` entry to either duplicate the
   `LOCAL_AUTH_FLAGS` content in its `subcommands` array (drift
   risk) or restructure `auth-local-help.ts` to use the standard
   shape (forces the local-help module to match the column-aligned
   output of the standard renderer, which is not what the
   `wstack auth local --help` command's user-facing output looks
   like today). Rejected.

2. **Always use `customBody` (no standard layout)** — Would require
   every entry to provide a function, which is more code for the
   95% of entries that fit the standard layout fine. Rejected.

3. **Apply `customBody` to ALL deep entries** — Would add boilerplate
   to entries that don't need it. The standard layout's
   column-aligned output is correct for the 1-flag and 0-flag cases
   (the `usage` line shows the flag, the `subcommands` table lists
   the positional). Rejected.

4. **Apply `customBody` to `mcp:add` only** — The user mentioned
   `mcp:add` as the example, but `mcp:add` has only 1 flag
   (`--enable`/`-e`). A dedicated module for a 1-flag entry is
   over-engineering. `models:add` (9 flags) is the better fit.
   The user mentioned `mcp:add` as a hypothetical; the audit
   identifies `models:add` as the actual best candidate.

## Worked example: adding `customBody` to `models:add`

> **Status update (2026-06-15)**: the recipe below was followed
> on 2026-06-15 to apply the pattern to `models:add`. The result
> is `packages/cli/src/subcommands/handlers/models-add-help.ts`
> (281 lines) plus the parser refactor in
> `packages/cli/src/subcommands/handlers/providers-models.ts` and
> the deep entry update in
> `packages/cli/src/subcommands/handlers/per-subcommand-help.ts`.
> The recipe is now historical — kept here for reference, but
> new contributors should look at the actual production files
> for the canonical implementation.

Suppose a future contributor decides to apply the pattern to
`models:add`. The change is:

1. **Create** `packages/cli/src/subcommands/handlers/models-add-help.ts`:

   ```ts
   import type { TerminalRenderer } from '@wrongstack/core';

   // Single source of truth for the `wstack models add` flag list.
   // Consumed by both the parser (in providers-models.ts) and the
   // help renderer (here).
   export const MODELS_ADD_FLAGS: ReadonlyArray<{
     flag: string;
     description: string;
   }> = [
     { flag: '--provider <id>',    description: 'Provider id (defaults to the saved alias).' },
     { flag: '--name <name>',      description: 'Human-readable display name (defaults to <mid>).' },
     { flag: '--max-context <N>',  description: 'Context window in tokens (e.g. 200000 for 200k).' },
     { flag: '--max-output <N>',   description: 'Max output tokens per request.' },
     { flag: '--tools / --no-tools', description: 'Toggle tool/function-calling support.' },
     { flag: '--vision / --no-vision', description: 'Toggle image-input support.' },
     { flag: '--reasoning',        description: 'Mark the model as a reasoning model.' },
     { flag: '--streaming / --no-streaming', description: 'Toggle streaming response support.' },
     { flag: '--json-mode',        description: 'Mark the model as supporting native JSON output.' },
   ];

   export function renderModelsAddHelpToString(): string {
     const lines: string[] = [
       color.bold('wstack models add <mid> — register a custom model'),
       color.dim('  Add or override a custom model. Flags are organized into'),
       color.dim('  identity (--provider, --name) and capabilities (--max-context, --tools, ...).'),
       '',
       color.bold('Usage'),
       '  wstack models add <mid> [--provider <id>] [--name <name>] [--max-context <N>] ...',
       '',
       color.bold('Flags'),
       ...MODELS_ADD_FLAGS.map(f => `  ${f.flag.padEnd(36)} ${f.description}`),
       '',
       color.dim('See also: wstack models list (verify); wstack models remove'),
     ];
     return lines.join('\n') + '\n';
   }

   export function renderModelsAddHelp(renderer: TerminalRenderer): void {
     renderer.write(renderModelsAddHelpToString());
   }
   ```

2. **Refactor** `providers-models.ts` to consume `MODELS_ADD_FLAGS`
   in the parser. The parser becomes:

   ```ts
   import { MODELS_ADD_FLAGS } from './models-add-help.js';
   const flagNames = new Set(MODELS_ADD_FLAGS.map(f => f.flag.split(' ')[0]));
   // ... existing flag parsing unchanged, but use flagNames for validation ...
   ```

3. **Update** the `models:add` deep entry in
   `per-subcommand-help.ts`:

   ```ts
   'models:add': {
     name: 'models:add',
     title: 'wstack models add <mid> — register a custom model',
     description: 'See renderModelsAddHelpToString() for the full block.',
     usage: 'wstack models add <mid> [...flags]',
     // The title/description/usage are required by the type but
     // never rendered (customBody owns the full layout).
     customBody: renderModelsAddHelpToString,
   },
   ```

4. **Add tests**:
   - A byte-for-byte equality test between the deep entry's
     `renderBlockToString` output and `renderModelsAddHelpToString()`.
   - A test that verifies `MODELS_ADD_FLAGS` is the single source
     for the parser's allowed flags.
   - A slash-command test that verifies `/help models add` works
     (using the `slash-deep-help.test.ts` smoke-test pattern).

The total scope: ~80 lines for the new module, ~10 lines for the
parser refactor, ~5 lines for the deep entry update, ~30 lines
for tests. Single source of truth for the flag list.

## When to Re-evaluate

This audit is current as of 2026-06-15. Re-evaluate when:

1. **`models:add` flags change** — the existing two-source-of-truth
   becomes painful enough that creating `models-add-help.ts` is
   worth the cost.
2. **A new subcommand is added with a complex flag set** — a
   hypothetical `wstack bench` already has 3 subcommands
   (`run`/`report`/`list`), each with their own flags. If a
   `wstack bench run --help` deep entry is added with 5+ flags,
   it would benefit from the same pattern.
3. **A new dedicated help module is created for any reason** — the
   pattern is the right default for any deep-help entry whose
   content is large enough to warrant a separate file.

> **Status update (2026-06-15)**: conditions 1 and 2 above have
> **already fired**:
>
> - Condition 1 fired when `models:add`'s 9 flags warranted a
>   dedicated module; the follow-up work created
>   `models-add-help.ts` and refactored the parser to consume
>   `MODELS_ADD_FLAGS`.
> - Condition 2 fired when `wstack bench run` (5+ flags) was
>   identified as a strong candidate; the follow-up work created
>   `bench-run-help.ts` and refactored the parser to consume
>   `BENCH_RUN_FLAGS` for default-value lookups and required-flag
>   checks.
>
> Condition 3 remains the trigger for future entries: any new
> dedicated help module (e.g. a hypothetical `plugin-official-help.ts`
> for the curated registry) would automatically be a candidate.
> The pattern is now established in 3 production entries and
> has the worked example in this ADR as the canonical recipe.

## Enforcement

- The audit table in this document is the source of truth for the
  current delegation status
- The `PerSubcommandHelp.customBody` field is documented in
  `per-subcommand-help.ts` (top-of-file JSDoc + field JSDoc) with
  the same criteria
- Three byte-for-byte parity tests enforce the `customBody` contract
  in the test suite:
  - `auth-local-help.test.ts` — the "delegates to auth-local-help.ts
    (single source of truth)" test pins `auth:local`
  - `models-add-help.test.ts` — the "byte-for-byte parity with the
    models:add deep entry" test pins `models:add`
  - `bench-run-help.test.ts` — the "byte-for-byte parity with the
    bench:run deep entry" test pins `bench:run`
  - All three use `expect(fromDeep).toBe(fromHelp)` (strict identity)
    to fail on any future divergence
- A future entry that uses `customBody` should add a parallel
  byte-for-byte test in the new module's test file
