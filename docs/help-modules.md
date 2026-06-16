# Help Module Author Guide

How to write a dedicated help module for a `wstack <sub>` or `wstack <sub> <deep>` invocation. Help modules are the canonical source of truth for a subcommand's flag list — they're consumed by both the help renderer (for `--help` output) and the parser (for default-value lookups and required-flag checks). Adding a new flag to a help module updates both surfaces automatically.

This guide is the **on-ramp**. For the historical context, see [Architecture Decision Record 002 — Help Delegation via `customBody`](adr/adr-002-help-delegation-pattern.md), which explains the rationale, the criteria, and the audit's predictions.

---

## When to write a help module

The `customBody` field on `PerSubcommandHelp` is the escape hatch for help blocks that don't fit the standard layout. Write a help module when **all three** of these are true:

1. **The deep entry has 3+ flags** — a 1-flag or 0-flag entry fits the standard layout fine (the `usage` line + a 1-row `subcommands` table is enough). A multi-row flag table benefits from column alignment.
2. **The dedicated handler module already exists or is being created** — the help module delegates to the handler's flag metadata, so the two stay in sync. Examples: `auth-local-help.ts` delegates to `auth.ts`'s flag knowledge, `models-add-help.ts` delegates to `providers-models.ts`, `bench-run-help.ts` delegates to `bench.ts`.
3. **The flags have meaningful metadata** — defaults, required-flag checks, group categorization, or `--flag / --no-flag` boolean counterparts. A 5-row table with `(--default: <value>)` annotations is exactly what `customBody` is for.

The 95/5 split: **most deep entries (95%) fit the standard layout fine** — they're either too small (1 flag), flag-shaped (the flag IS the entry), or trivial (single positional). Only the **complex 5%** benefit from a dedicated help module. As of 2026-06-15, the 3 entries that meet the criteria are `auth:local`, `models:add`, and `bench:run`.

The full audit table is in [ADR 002 § Audit of existing deep entries](adr/adr-002-help-delegation-pattern.md#audit-of-existing-deep-entries) — 35 entries, 3 "Already done", 32 "No". The 32 "No" verdicts have all held up: none have been refactored since the original audit, confirming the 95/5 split in practice.

---

## The minimum viable help module

Here's the shape of a help module. The 3 production examples (`auth-local-help.ts`, `models-add-help.ts`, `bench-run-help.ts`) all follow this structure:

```ts
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from '../../renderer.js';

// ── Data shape ────────────────────────────────────────────────────────

export interface MySubcommandFlag {
  /** The flag's canonical name (no `--` prefix, no value placeholder). */
  name: string;
  /**
   * The display form, with the `--` prefix and any value
   * placeholder. For boolean flags, include both forms
   * (e.g. `'--tools / --no-tools'`).
   */
  flag: string;
  /** One-line description shown in the help block. */
  description: string;
  /**
   * Which semantic group the flag belongs to. The renderer
   * prints a subheader when the group changes between
   * consecutive entries.
   */
  group: 'identity' | 'capabilities';  // pick your own categories
  /** Parser shape: `boolean` for toggles, `value` for `--flag <v>`. */
  kind: 'boolean' | 'value';
  /** Optional: default value (rendered as `(default: <value>)`). */
  defaultValue?: string;
  /** Optional: mark the flag as required (rendered as `(required)`). */
  required?: boolean;
}

// ── The flag list (the single source of truth) ───────────────────────

export const MY_SUBCOMMAND_FLAGS: ReadonlyArray<MySubcommandFlag> = [
  // -- Identity --------------------------------------------------------
  { name: 'name',  flag: '--name <name>',  description: '...', group: 'identity',     kind: 'value' },
  // -- Capabilities ---------------------------------------------------
  { name: 'tools', flag: '--tools / --no-tools', description: 'Toggle tool support.', group: 'capabilities', kind: 'boolean' },
  { name: 'count', flag: '--count <N>',    description: '...', group: 'capabilities', kind: 'value', defaultValue: '10' },
];

// ── Derived lists (for the parser) ───────────────────────────────────

export const MY_SUBCOMMAND_BOOLEAN_FLAG_NAMES: ReadonlyArray<string> =
  MY_SUBCOMMAND_FLAGS.filter(f => f.kind === 'boolean').map(f => f.name);
export const MY_SUBCOMMAND_VALUE_FLAG_NAMES: ReadonlyArray<string> =
  MY_SUBCOMMAND_FLAGS.filter(f => f.kind === 'value').map(f => f.name);

// ── Renderer ─────────────────────────────────────────────────────────

export const MY_SUBCOMMAND_FLAG_COLUMN_WIDTH = 30;

export function renderMySubcommandHelpToString(): string {
  const lines: string[] = [
    color.bold('wstack my-subcommand — short description'),
    color.dim('  Longer description, wrapped at the call site.'),
    color.dim('  Multi-line is fine — 2-4 lines usually.'),
    '',
    color.bold('Usage'),
    `  ${buildUsageLine()}`,
    '',
    color.bold('Flags'),
    ...buildFlagBlock(),
    '',
    color.dim('See also: wstack <related-subcommand>'),
  ];
  return lines.join('\n') + '\n';
}

function buildUsageLine(): string {
  const parts: string[] = ['wstack my-subcommand'];
  for (const f of MY_SUBCOMMAND_FLAGS) {
    parts.push(`[${f.flag}]`);
  }
  return parts.join(' ');
}

function buildFlagBlock(): string[] {
  const rows: string[] = [];
  let currentGroup: string | undefined;
  for (const f of MY_SUBCOMMAND_FLAGS) {
    if (f.group !== currentGroup) {
      rows.push(color.dim(`  ${capitalize(f.group)}:`));
      currentGroup = f.group;
    }
    const padded = f.flag.padEnd(MY_SUBCOMMAND_FLAG_COLUMN_WIDTH, ' ');
    let desc = f.description;
    if (f.required) desc += ' ' + color.bold('(required)');
    else if (f.defaultValue !== undefined) desc += ' ' + color.dim(`(default: ${f.defaultValue})`);
    rows.push(`  ${padded} ${desc}`);
  }
  return rows;
}

function capitalize(s: string): string {
  return s[0]?.toUpperCase() + s.slice(1);
}

export function renderMySubcommandHelp(renderer: TerminalRenderer): void {
  renderer.write(renderMySubcommandHelpToString());
}
```

The shape has 4 layers: **data shape** (the interface), **flag list** (the source of truth), **derived lists** (for the parser), **renderer** (the help block). All 3 production modules follow this exact structure.

---

## Wiring the help module into the dispatch

A help module is useless on its own — the help block has to reach the four invocation surfaces:

1. `wstack <sub> --help` (top-level CLI bypass)
2. `wstack <sub> <deep> --help` (deep-subcommand CLI bypass)
3. `/<slash> <sub> [deep] help` (in-REPL slash command)
4. `/help <sub> [deep]` (in-REPL dispatch help)

All four surfaces read from the same data structures (`helpTable` + `deepHelpTable` in `per-subcommand-help.ts`) and the same renderer functions (`renderFocusedHelp` / `renderDeepHelp`). Wiring the help module is a 3-step process:

### Step 1: Add the deep entry to `deepHelpTable`

In `packages/cli/src/subcommands/handlers/per-subcommand-help.ts`, add an entry to the `deepHelpTable`:

```ts
'bench:run': {  // or whatever <sub>:<deep> you need
  name: 'bench:run',
  title: 'wstack bench run — short title',
  description: 'See renderMySubcommandHelpToString() in <file>.ts for the full block.',
  usage: 'wstack bench run [...flags]',
  // The `customBody` thunk owns the full layout. The fields above
  // are required by the type but never rendered.
  customBody: renderMySubcommandHelpToString,
},
```

The `title` / `description` / `usage` / `seeAlso` fields are required by `PerSubcommandHelp` but never rendered when `customBody` is set. They're filled in with sensible defaults so a future refactor that drops `customBody` (e.g. to use the standard layout) has a coherent fallback. See the [Field JSDoc section](#per-subcommandhelp-shape) below for the full contract.

### Step 2: Add the `--help` short-circuit to the handler

In `packages/cli/src/subcommands/handlers/<sub>.ts`, at the top of the handler function, add:

```ts
import { renderDeepHelp, renderFocusedHelp } from './per-subcommand-help.js';

export const mySubCmd: SubcommandHandler = async (args, deps) => {
  // `--help` / `-h` short-circuit.
  if (args.includes('--help') || args.includes('-h')) {
    if (renderDeepHelp('<sub>:<deep>', deps.renderer)) return 0;
  }
  // ... rest of the handler ...
};
```

The bypass in `cli-main.ts` (which handles the `wstack <sub> --help` and `wstack <sub> <deep> --help` cases) re-injects `--help` into the args passed to the subcommand, so the handler's check fires for all four surfaces. The slash-command surface (`/<slash> <sub> [deep] help`) also routes through the handler's check via the slash-command dispatcher's `wantsDeepHelp` short-circuit.

### Step 3: Refactor the parser to consume the flag list

The parser is the most variable part of the refactor — different subcommands have different dispatch structures. The 3 production examples show three approaches:

**`models:add` — full iteration** (the cleanest pattern). The parser iterates the derived flag-name lists and reads each flag generically:

```ts
import {
  MODELS_ADD_BOOLEAN_FLAG_NAMES,
  MODELS_ADD_VALUE_FLAG_NAMES,
  buildModelsAddUsageLine,
} from './models-add-help.js';

async function modelsAdd(args: string[], deps: SubcommandDeps): Promise<number> {
  // `--help` / `-h` short-circuit (via the deep entry).
  if (args.includes('--help') || args.includes('-h')) {
    if (renderDeepHelp('models:add', deps.renderer)) return 0;
  }

  // The parser reads the flags using the derived name lists.
  // Adding a new flag to MODELS_ADD_FLAGS is the only place the
  // flag metadata needs to be updated.
  for (const flagName of MODELS_ADD_VALUE_FLAG_NAMES) {
    const raw = typeof flags[flagName] === 'string' ? flags[flagName] : undefined;
    if (raw === undefined) continue;
    // ... per-flag switch ...
  }
  // ...
}
```

**`bench:run` — partial refactor** (the dispatch structure is complex, so the parser uses helpers but not full iteration):

```ts
import { BENCH_RUN_FLAGS } from './bench-run-help.js';

function getBenchRunDefault(name: string, fallback: string): string {
  return BENCH_RUN_FLAGS.find(f => f.name === name)?.defaultValue ?? fallback;
}

function isBenchRunRequired(name: string): boolean {
  return BENCH_RUN_FLAGS.find(f => f.name === name)?.required === true;
}

async function benchRun(args: string[], deps: SubcommandDeps): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    if (renderDeepHelp('bench:run', deps.renderer)) return 0;
  }
  // Use the helpers for default-value lookups, but keep
  // the dispatch-specific flag reads as direct flagStr calls.
  const suiteId = flagStr(deps, 'suite') ?? getBenchRunDefault('suite', 'polyglot');
  // ... dispatch logic ...
}
```

**`auth:local` — pre-existing module** (the help module was created before the pattern was established):

```ts
import { LOCAL_AUTH_FLAGS, renderAuthLocalHelp } from './auth-local-help.js';

async function authLocal(args: string[], deps: SubcommandDeps): Promise<number> {
  if (wantsLocalHelp(args)) {
    renderAuthLocalHelp(deps.renderer);
    return 0;
  }
  // ... existing logic, unchanged ...
}
```

The `auth-local-help.ts` module was a pre-existing artifact — the `customBody` delegation was a one-line addition that brought an existing module into the per-subcommand-help system. New help modules should follow the `models:add` / `bench:run` pattern (data-driven from the start).

---

## The `PerSubcommandHelp` shape

The `PerSubcommandHelp` interface (in `packages/cli/src/subcommands/handlers/per-subcommand-help.ts`) has 6 fields. When `customBody` is set, only 1 of them matters at runtime:

| Field | Required | Rendered when `customBody` is set? | Notes |
|---|---|---|---|
| `name` | yes | no (used for iteration only) | A short identifier like `'bench:run'`. |
| `title` | yes | **no** (customBody owns it) | Required by the type for test-infrastructure uniformity. |
| `description` | yes | **no** | Required by the type. Filled with a sensible fallback. |
| `usage` | yes | **no** | Required by the type. Filled with `'wstack <sub> [...flags]'`. |
| `subcommands` | no | **no** | The `subcommands` array is replaced by `customBody`. |
| `seeAlso` | no | **no** | Replaced by the custom body's closing lines. |
| `customBody` | no | **yes** | When set, replaces the standard layout. The function returns the full help block. |

**The `customBody` field is a thunk, not a value.** It's a `() => string`, not a `string`. This matters because:

- Tests that import the data table (e.g. the "every entry has a non-empty title" test) don't trigger the lazy evaluation. If `customBody` were a `string`, importing the table would force the body to be built.
- The thunk can call back into a module that imports `PerSubcommandHelp`. A `string` value would be evaluated at module-load time, when the import cycle hasn't resolved yet.

In short: `customBody` is a *delegate*, not a *value*. The data table stays pure data; the rendering is lazy.

---

## Field JSDoc

The `PerSubcommandHelp.customBody` field has a short JSDoc that points at this document for the full pattern:

```ts
/**
 * Optional custom body renderer. When set, the standard
 * title / description / usage / subcommands / seeAlso layout
 * is **replaced** by whatever this function returns. ...
 *
 * **See the top-of-file JSDoc for the full "delegation pattern"
 * documentation** (when to use, when NOT to use, a worked
 * example for adding a new delegated entry, and the
 * single-source-of-truth contract).
 */
customBody?: () => string;
```

The canonical reference is the top-of-file JSDoc in `per-subcommand-help.ts` (which itself points back at this document for the on-ramp). Together they form a documentation graph: a contributor reading the field learns the mechanism; a contributor reading the file top learns when to reach for it; a contributor reading this guide learns the full pattern.

---

## Testing the help module

Every help module needs a test file in `packages/cli/tests/`. The 3 production test files (`auth-local-help.test.ts`, `models-add-help.test.ts`, `bench-run-help.test.ts`) all follow this structure:

```ts
import { describe, expect, it } from 'vitest';
import {
  MY_SUBCOMMAND_FLAGS,
  renderMySubcommandHelpToString,
} from '../src/subcommands/handlers/my-subcommand-help.js';
import { renderDeepHelpToString } from '../src/subcommands/handlers/per-subcommand-help.js';

describe('my-subcommand-help', () => {
  describe('MY_SUBCOMMAND_FLAGS (the source of truth)', () => {
    // Tests that the array has the right size, every entry has
    // non-empty fields, the boolean/value lists match, no duplicate
    // names, etc.
  });

  describe('renderMySubcommandHelpToString (the help block)', () => {
    // Tests that the block contains the title, every flag, the
    // group subheaders, the See also line, etc.
  });

  describe('byte-for-byte parity with the deep entry', () => {
    it('renderDeepHelpToString("<sub>:<deep>") === renderMySubcommandHelpToString()', () => {
      // The contract pin: a future divergence fails the test.
      expect(renderDeepHelpToString('<sub>:<deep>')).toBe(renderMySubcommandHelpToString());
    });
  });

  describe('buildMySubcommandUsageLine (the parser fallback)', () => {
    // Tests that the usage line is well-formed.
  });
});
```

The **byte-for-byte parity test** is the contract pin. It uses `expect(fromDeep).toBe(fromHelp)` (strict identity) so any future divergence between the deep entry's rendering and the help module's renderer fails. All 3 production help modules have this test; a future help module should add one too.

---

## End-to-end smoke test

After wiring, verify all 4 surfaces produce the same byte-for-byte string:

```bash
# Build first
cd packages/cli && pnpm run build

# Top-level CLI bypass
node packages/cli/dist/index.js <sub> [deep] --help

# Slash-command surface (requires a /<sub> slash command)
# If /<sub> doesn't exist yet, skip this surface for now
# and add it when the slash command is added.

# In-REPL dispatch help
node packages/cli/dist/index.js <sub> [deep] --help
# (the --help flag is re-injected into the args by the bypass,
#  so this is the same code path as the slash-command surface)
```

All surfaces should print the same block. If they diverge, the deep entry's `customBody` is not wired correctly (or the slash-command dispatch isn't routing through the handler's `--help` short-circuit).

---

## Worked example: adding `customBody` to a hypothetical `plugin:official`

Suppose a future contributor wants to add a `wstack plugin official --help` deep entry. The `wstack plugin official` command lists the curated plugin registry (`telegram`, `lsp`); the help block would have ~3 rows. The change is:

1. **Create** `packages/cli/src/subcommands/handlers/plugin-official-help.ts` (modeled on `models-add-help.ts`):

   ```ts
   import { color } from '@wrongstack/core';
   import type { TerminalRenderer } from '../../renderer.js';

   export const PLUGIN_OFFICIAL_FLAGS: ReadonlyArray<{
     name: string;
     flag: string;
     description: string;
   }> = [
     { name: 'include-source', flag: '--include-source', description: 'Include the source URL in the output.' },
     { name: 'json',          flag: '--json',          description: 'Emit the registry as JSON (default: table).' },
   ];

   export function renderPluginOfficialHelpToString(): string {
     // ... build the block (title + description + usage + flag table + Examples) ...
   }

   export function renderPluginOfficialHelp(renderer: TerminalRenderer): void {
     renderer.write(renderPluginOfficialHelpToString());
   }
   ```

2. **Add the deep entry** to `deepHelpTable`:

   ```ts
   'plugin:official': {
     name: 'plugin:official',
     title: 'wstack plugin official — list the curated official registry',
     description: 'See renderPluginOfficialHelpToString() in plugin-official-help.ts for the full block.',
     usage: 'wstack plugin official [--include-source] [--json]',
     customBody: renderPluginOfficialHelpToString,
   },
   ```

3. **Add the `--help` short-circuit** to the `pluginCmd` handler (which already has a `help` short-circuit for the top-level case):

   ```ts
   if (args.includes('--help') || args.includes('-h')) {
     // Try the deep entry first (e.g. `wstack plugin official --help`).
     const deepKey = args[0] && args[1] ? `${args[0]}:${args[1]}` : undefined;
     if (deepKey && renderDeepHelp(deepKey, deps.renderer)) return 0;
     // Otherwise, render the top-level help.
     if (renderFocusedHelp('plugin', deps.renderer)) return 0;
   }
   ```

4. **Add tests** (in `plugin-official-help.test.ts`):

   ```ts
   describe('plugin-official-help', () => {
     // ... data-shape tests ...
     // ... renderer tests ...
     it('renderDeepHelpToString("plugin:official") === renderPluginOfficialHelpToString()', () => {
       expect(renderDeepHelpToString('plugin:official')).toBe(renderPluginOfficialHelpToString());
     });
   });
   ```

5. **Verify** all 4 surfaces produce the same string (smoke test in the `cli` package).

The total scope: ~100 lines for the new module, ~5 lines for the deep entry, ~5 lines for the short-circuit, ~30 lines for tests. Single source of truth for the flag list.

---

## Cross-references

- **ADR 002 — Help Delegation via `customBody`** — the historical record. Includes the original audit, the "When to use / when NOT to use" criteria, and the status update documenting that the audit's predictions have been confirmed.
- **`docs/subcommands/README.md`** — the per-subcommand documentation index. The 3 production help modules correspond to 3 entries in this index.
- **`packages/cli/src/subcommands/handlers/per-subcommand-help.ts`** — the source of truth for the per-subcommand help data. The top-of-file JSDoc is the canonical reference for the `customBody` field's contract.
- **The 3 production help modules** — `auth-local-help.ts`, `models-add-help.ts`, `bench-run-help.ts` — are the canonical examples. Use them as templates.
