# /init — Project Context Generator

## What it does

`/init` creates or overwrites `.wrongstack/AGENTS.md` — a file loaded into WrongStack's system prompt as persistent project context on every session start.

Every invocation re-runs project auto-detection and writes the template fresh. If you have manually edited the file, run `/init` again to update the auto-detected parts while your custom notes stay (the template tells the agent "DO NOT DELETE").

## Auto-detection

`detectProjectFacts()` probes the project root through three tiers — **manifests**, then **CI workflows** (gap-fill), then a **source-tree scan** (last resort). Each field is filled by the first tier that provides it; later tiers never override an earlier one.

### Tier 1 — manifests

| File | Build | Test | Lint | Run |
|---|---|---|---|---|
| `package.json` + pnpm lock | `pnpm run build` | `pnpm test` | `pnpm run lint` | `pnpm run <dev/start/serve/preview>` |
| `package.json` + yarn lock | `yarn run build` | `yarn test` | ... | ... |
| `package.json` + bun lock | `bun run build` | `bun test` | ... | ... |
| `pyproject.toml` | — | `pytest` | `ruff check .` | — |
| `go.mod` | `go build ./...` | `go test ./...` | — | `go run .` |
| `Cargo.toml` | `cargo build` | `cargo test` | `cargo clippy` | `cargo run` |
| `Makefile` | `make <build\|>` | `make test` (if target) | `make lint` (if target) | `make <run\|dev\|start>` |
| `composer.json` | — | `composer test` (if script) | `composer lint` (if script) | — |
| `pom.xml` (Maven) | `mvn package` | `mvn test` | — | — |
| `build.gradle(.kts)` | `<./gradlew\|gradle> build` | `<./gradlew\|gradle> test` | — | — |
| `*.csproj` / `*.sln` / `global.json` | `dotnet build` | `dotnet test` | — | `dotnet run` |
| `mix.exs` (Elixir) | `mix compile` | `mix test` | `mix format --check-formatted` | `mix run` |
| `pubspec.yaml` (Dart) | — | `dart test` | `dart analyze` | — |
| `deno.json(c)` | — | `deno test` | `deno lint` | — |
| `Package.swift` | `swift build` | `swift test` | — | `swift run` |
| `Gemfile` (+`Rakefile`) | — | `bundle exec rake test` | — | — |
| `CMakeLists.txt` | `cmake -B build && cmake --build build` | `ctest --test-dir build` | — | — |
| `requirements.txt` / `setup.py` / `setup.cfg` | — | `pytest` | — | — |

Order: `package.json` → Python (pyproject) → Go → Rust → Make → Composer → Maven → Gradle → .NET → Elixir → Dart → Deno → Swift → Ruby → CMake → pip-Python.

### Tier 2 — CI workflows (gap-fill)

If build/test/lint is still missing, `.github/workflows/*.yml` is parsed (no YAML dependency — line-based) for `run:` steps in both inline (`run: pnpm test`) and block-scalar (`run: |` + indented lines) form. Obvious noise (`cd`/`echo`/`export`/comments) is dropped, then the literal commands are matched by keyword to fill the remaining fields. CI is strong evidence — these commands actually run on every push. Adds the `.github/workflows` hint only when something matched.

### Tier 3 — source-tree scan (last resort)

If **no command at all** was found, the source tree is walked (skipping `node_modules`/`.git`/build dirs, capped at 5000 files / depth 6). It reports the dominant languages by file count, likely entry points (`main.*`, `index.*`, `app.*`, `cli.*`, `server.*`, `__main__.*`), and top-level directories — surfaced in the AGENTS.md "Runtime" line and the "Key files" table. **Commands are never fabricated**: if no manifest/CI evidence exists they stay `_TODO_`, so a pattern-less project still gets an honest, language-aware skeleton.

## Template sections

```
## Project brief        — Purpose, users, runtime (+ detected languages), hints
## How to work safely  — Rules, protected files, known fragile areas
## Commands            — Build/Test/Lint/Run as table (_TODO_ when unknown)
## Key files and entry points — scan-derived entry points/dirs, else src/tests/docs/scripts
## Architecture notes  — Modules, layers, extension points
## Domain knowledge    — Business rules, acronyms, intentional quirks
## Verification checklist — What to run after changes, smoke tests
## Useful pointers     — Docs, dashboards, related repos
```

## REPL vs `wstack init` subcommand

| Entry | Behavior |
|---|---|
| `/init` in REPL | Writes `.wrongstack/AGENTS.md` only |
| `wstack init` subcommand | Interactive provider/model setup → `~/.wrongstack/config.json` + same AGENTS.md logic |

Both use the same `detectProjectFacts()` + `renderAgentsTemplate()` from `helpers.ts`.

## Code reference

- `packages/cli/src/slash-commands/init.ts` — slash command
- `packages/cli/src/slash-commands/helpers.ts` — `detectProjectFacts()` + `renderAgentsTemplate()`
- `packages/cli/src/subcommands/handlers/init.ts` — `wstack init` subcommand
- `packages/cli/tests/slash-init.test.ts` — tests