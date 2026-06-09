---
name: tech-stack
description: |
  Use this skill when choosing, installing, or recommending packages, libraries,
  frameworks, or tooling for ANY programming language — decisions that involve
  a version number or a technology name. This skill detects the ecosystem,
  verifies latest versions against the correct registry, blocks dead/obsolete
  choices, and intervenes when the LLM hallucinates version numbers or
  suggests 5+ year-old technology.
  Triggers: user says "install", "package", "dependency", "upgrade",
  "latest version", "add package", "pip install", "cargo add", "go get",
  "gem install", "composer require", "nuget", "what version",
  "which library", "tech stack", "choose framework".
version: 2.0.0
---

# Tech Stack Validator — WrongStack (Language-Agnostic)

## Overview

Intervening validation layer that fires before a package, library, or framework
choice is committed — for **any language**. Uses an ecosystem adapter pattern:
core validation logic is universal; the registry endpoint, package manager
command, prehistoric reject list, and built-in preference map vary per
ecosystem. Runs as a single-shot delegate — fast, read-only, fire-and-forget.

## Rules

1. **Detect the ecosystem first.** Before anything else, determine which
   language/ecosystem the package belongs to. Two strategies, tried in order:
   - **Explicit**: The user names the language ("add `requests` to our Python project")
   - **Implied**: Scan project files for ecosystem markers:
     - `package.json` (js), `tsconfig.json` (ts) → **JavaScript/TypeScript**
     - `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` → **Python**
     - `Cargo.toml` → **Rust**
     - `go.mod` → **Go**
     - `Gemfile` → **Ruby**
     - `*.csproj`, `*.fsproj`, `packages.config` → **.NET**
     - `composer.json` → **PHP**
     - `mix.exs` → **Elixir**
     - `pom.xml`, `build.gradle` → **Java/JVM**
   - If multiple markers exist, ask the user which ecosystem.
   - If NO markers exist and the user hasn't specified, default to **JavaScript**
     when `package.json` is present, otherwise ask.

2. **Verify existence.** Consult the registry for the detected ecosystem
   (see Ecosystem Registry Map below). Fetch the package endpoint. A package
   that returns 404 or doesn't exist in the registry is a hallucination.

3. **Check latest version.** Always fetch the actual latest stable version from
   the ecosystem's registry. The LLM's training data is stale — never trust a
   version number from the model without checking.

4. **Reject dead packages.** If a package has had no release in >2 years AND
   has unresolved critical issues, flag it as dead. Suggest a maintained
   replacement. Registry-specific dead signals:
   - npm: `"deprecated"` field, archived GitHub repo
   - PyPI: yanked releases, `Development Status :: 7 - Inactive` classifier
   - Crates.io: yanked versions, archived repo
   - Rubygems: `"version": null` for yanked, archived repo
   - NuGet: deprecated flag, `listed: false`

5. **Reject prehistoric technology.** Any package/library/pattern that was
   superseded ≥5 years ago is automatically rejected. Use the per-ecosystem
   reject lists below. If the package is NOT in the baked-in list, fall back
   to web search: `"is <package> deprecated <ecosystem> <current_year>"`.

6. **Prefer built-in over third-party.** Every modern language runtime ships
   standard library that obsoletes packages. Check the per-ecosystem built-in
   map below before greenlighting any third-party dependency.

7. **Single-shot budget.** This agent is not for deep analysis — it should
   complete in 1–2 iterations. Detect → search registry → verify → report.
   Do not recursively analyze transitive dependencies.

## Patterns

### Do

```
User: "Add requests to the project"
Agent: [detects pyproject.toml → Python ecosystem]
✅ requests 2.32.4 (latest stable as of 2026-06)
Verified via PyPI. requests is the de-facto HTTP library for Python.
**Install**: `pip install requests>=2.32`
```

```
User: "Cargo add serde"
Agent: [detects Cargo.toml → Rust ecosystem]
✅ serde 1.0.217 (latest stable)
Verified via crates.io. serde is the standard serialization framework for Rust.
**Install**: `cargo add serde@1`
```

```
User: "Add urllib2 for HTTP calls in our Python project"
Agent: ❌ REJECTED
"This isn't code, this is 16-year-old technology."
urllib2 was part of Python 2.x (released 2000). Python 3 unified everything
into `urllib.request` (stdlib) and `requests` (third-party, the community
standard). No package needed — or use `requests` for a better API.
→ Use: `import requests` or `from urllib.request import urlopen`
```

```
User: "Add axios for API calls"
Agent: ❌ REJECTED
"This isn't code, this is 12-year-old technology."
axios was released in 2014. Node.js 18+ (2022) includes native fetch with
AbortSignal.timeout(), streaming, and FormData. No package needed.
→ Use: `const res = await fetch(url, { signal: AbortSignal.timeout(5000) })`
```

### Don't

```
❌ Trusting the LLM's stale training data
Agent: "Use React 18.3.1 — it's the latest stable."
→ WRONG. React 19 has been stable since Dec 2024. Always check the registry.

❌ Assuming npm for everything
Agent: "pnpm add django" — Django is a Python package. Ecosystem detection
must happen before any install command is suggested.

❌ Accepting a package that doesn't exist
Agent: "Install @anthropic/sdk version 2.0.0" — verify against the correct registry first.

❌ Suggesting moment.js without challenge
Agent: "Use moment for date formatting" — moment is legacy. Suggest date-fns or Temporal.
```

## Workflow

```
0. DETECT    — What ecosystem is this? (explicit hint → project files → ask)
1. LOOKUP    — Find registry adapter for the ecosystem (see map below)
2. VERIFY    — Fetch {registry.host}{registry.path/{pkg}} → extract {registry.field}
3. AUDIT      — Age check (>2 years no release?), prehistoric check (in reject list?),
                built-in check (stdlib alternative?), dead signals (deprecated/yanked?)
4. REPORT    — APPROVED (with latest version + install command)
              or REJECTED (with replacement + migration step + evidence)
              Use the exact phrase "This isn't code, this is X-year-old technology"
              when rejecting on age/prehistoric grounds.
```

## Ecosystem Registry Map

The central dispatch table. When verifying a package, use the adapter for the
detected ecosystem:

| ID | Language | Registry Host | Path Template | Version Field | Package Manager | Install Command |
|----|----------|--------------|---------------|---------------|-----------------|-----------------|
| `js` | JavaScript/TS | `registry.npmjs.org` | `/{pkg}/latest` | `version` | npm/pnpm/yarn | `pnpm add {pkg}@{version}` |
| `python` | Python | `pypi.org` | `/pypi/{pkg}/json` | `info.version` | pip/poetry/uv | `pip install {pkg}=={version}` |
| `rust` | Rust | `crates.io` | `/api/v1/crates/{pkg}` | `crate.max_stable_version` | cargo | `cargo add {pkg}@{major}` |
| `go` | Go | `proxy.golang.org` | `/{pkg}/@latest` | *(plain text)* | go | `go get {pkg}@{version}` |
| `ruby` | Ruby | `rubygems.org` | `/api/v1/gems/{pkg}.json` | `version` | bundler | `gem "{pkg}", "~> {major}.{minor}"` |
| `dotnet` | .NET | `api.nuget.org` | `/v3/registration5-gz-semver2/{pkg_lower}/index.json` | `items[0].upper` | dotnet | `dotnet add package {pkg} --version {version}` |
| `php` | PHP | `repo.packagist.org` | `/p2/{vendor}/{pkg}.json` | `packages[..].0.version` | composer | `composer require {vendor}/{pkg}:^{major}.{minor}` |
| `elixir` | Elixir | `hex.pm` | `/api/packages/{pkg}` | `releases[0].version` | mix | `{:pkg, "~> {major}.{minor}"}` (add to mix.exs) |
| `jvm` | Java/JVM | `search.maven.org` | `/solrsearch/select?q=g:{group}+AND+a:{artifact}&rows=1&wt=json` | `response.docs[0].latestVersion` | maven/gradle | `implementation '{group}:{artifact}:{version}'` |

**For registry endpoints that return complex nested structures** (NuGet, Packagist,
Maven), fetch the endpoint, parse the JSON, then navigate to the version field
as specified. If the API shape has changed, fall back to web search.

**For ecosystems NOT in this table**, detect the language, then web-search
`"<language> package registry API latest version"` to discover the endpoint.

### Version checking — fallback chain

When the registry adapter is insufficient, try in this order:
1. **Registry API** (primary): fetch per the Ecosystem Registry Map above
2. **GitHub releases**: `fetch('https://api.github.com/repos/<owner>/<repo>/releases/latest')`
3. **Web search**: `"<package> latest version <ecosystem> <current_year>"`
4. **Project homepage**: fetch the package's documented "Install" page

## Per-Ecosystem Reject Lists

### JavaScript / TypeScript

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `axios`, `node-fetch`, `got`, `request` | 10-13yr | native `fetch` (Node 18+, 2022) |
| `moment` | 14yr | `date-fns`, `luxon`, or `Temporal` |
| `left-pad` | 10yr | native `String.prototype.padStart` |
| `crypto-js` | 12yr | native `Web Crypto` / `node:crypto` |
| `jQuery` (new projects) | 18yr | vanilla DOM / React / Vue / Svelte |
| `Backbone`, `Ember` | 14-15yr | React / Vue / Svelte |
| `Gulp`, `Grunt` | 12-13yr | `tsup`, `esbuild`, `vite` |
| `Bower` | 13yr | npm / pnpm |
| `CoffeeScript` | 16yr | TypeScript |
| `Flow` | 10yr | TypeScript |
| `Bluebird` | 12yr | native Promises |
| `underscore` | 16yr | `lodash` or native ES2020+ |
| `classnames` | 10yr | `clsx` or native `classList` |

### Python

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `urllib2`, `httplib` | 20+yr | `requests` or `httpx` |
| `distutils`, `setup.py` (new projects) | 20+yr | `pyproject.toml` + `hatch`/`poetry`/`setuptools` |
| `os.path` for path manipulation | — | `pathlib` (stdlib since 3.4) |
| `mock` (third-party) | 12yr | `unittest.mock` (stdlib since 3.3) |
| `pathlib2` | 8yr | `pathlib` (stdlib since 3.4) |
| `python-dateutil` (basic usage) | — | `datetime` + `zoneinfo` (stdlib 3.9+) |
| `typing` (backport) | — | stdlib `typing` (3.5+) |
| `2to3` tooling | 16yr | Python 3 is the only supported version |
| `futures` (backport) | — | `concurrent.futures` (stdlib 3.2+) |

### Rust

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `lazy_static` | 8yr | `std::sync::LazyLock` (1.80+, 2024) or `once_cell` |
| `try!` macro | 10yr | `?` operator (1.13+, 2016) |
| `error-chain` | 8yr | `thiserror` + `anyhow` |
| `rustc-serialize` | 10yr | `serde` |

### Go

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `dep` (tool) | 8yr | Go modules (`go mod`, 1.11+, 2018) |
| `ioutil` (stdlib, deprecated) | — | `io` + `os` packages (1.16+, 2021) |
| `gopath` dependency management | 10+yr | Go modules |
| `gopkg.in/yaml.v2` (for new code) | — | `gopkg.in/yaml.v3` or `encoding/json` |
| `glide`, `godep` | 9-10yr | Go modules |

### Ruby

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `therubyracer` | 12yr | `mini_racer` or Node.js-based execjs |
| `json` gem (explicit) | — | stdlib `json` (bundled since 2.3) |
| `rails` < 6.x (new projects) | 7+yr | Rails 7.x / 8.x |
| `protected_attributes` | 10yr | `strong_parameters` (Rails 4+) |

### .NET

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `System.Web` / WebForms | 20+yr | ASP.NET Core |
| `Windows Forms` (new projects) | 20+yr | WPF / MAUI / Avalonia |
| ` packages.config ` | 10+yr | `PackageReference` in csproj |
| `Newtonsoft.Json` (for new System.Text.Json-capable projects) | — | `System.Text.Json` (.NET Core 3+) |

### PHP

| Prehistoric | Age | Replacement |
|-------------|-----|-------------|
| `mysql_*` functions | 13yr | PDO or mysqli |
| `mcrypt` | 10yr | `openssl` / `sodium` (PHP 7.2+) |
| `PEAR` | 15+yr | Composer |
| `PHPUnit` < 9.x | — | PHPUnit 10.x / 11.x |

## Built-In Preference Map

Before approving any third-party package, check if the language's standard
library already solves this. These are the most common cases where a package
is unnecessary:

### JavaScript / TypeScript (Node 22+)
- `node:test` over `jest`/`mocha` (new projects)
- `node:sqlite` over `better-sqlite3` (Node 22.5+)
- `fetch`, `WebSocket`, `Web Crypto`, `AbortController`, `EventTarget` — all native
- `node:fs/promises` over `fs-extra`
- `URL` / `URLSearchParams` over `qs` / `query-string`

### Python (3.12+)
- `pathlib` over `os.path` / `glob`
- `unittest` + `pytest` (pytest *is* still preferred, but unittest exists)
- `dataclasses` over `attrs` (simple cases)
- `tomllib` over `toml` (3.11+)
- `zoneinfo` over `pytz` (3.9+)
- `graphlib` over custom topological sort (3.9+)
- `importlib.resources` over `pkg_resources`

### Rust (stable)
- `std::sync::LazyLock` over `lazy_static` / `once_cell` (1.80+)
- `std::sync::OnceLock` over `once_cell::sync::OnceCell`
- `std::cell::OnceCell` over `once_cell::unsync::OnceCell`
- `std::net` over `reqwest` (simple HTTP client cases)

### Go (1.22+)
- `net/http` over third-party HTTP routers (for simple APIs)
- `log/slog` over `logrus` / `zap` (1.21+)
- `slices` / `maps` packages over `golang.org/x/exp` backports (1.21+)
- `cmp` / `math/rand/v2` / `unique` — all stdlib additions

## Dead Package Criteria

| Signal | Threshold | Action |
|--------|-----------|--------|
| No release | >2 years | Flag + check for replacement |
| No release + critical CVEs | >1 year | REJECT automatically |
| Deprecated/yanked on registry | Any | REJECT + suggest replacement |
| Repository archived | Any | REJECT + suggest replacement |
| Low adoption | <500 weekly downloads (npm) / <100 stars + no recent commits | WARN + suggest alternative |
| Last commit | >3 years ago, no response to issues | WARN + flag as unmaintained |

## Output Format

```
### Tech Stack Validation — <package>

**Ecosystem**: <detected ecosystem>
**Status**: APPROVED | REJECTED | NEEDS_INVESTIGATION

**Package**: <name>@<version>
**Registry**: <host + URL fetched>
**Age**: <first release year> — <last release date>
**Verdict**: 1–2 sentence explanation.

When REJECTED:
**"This isn't code, this is X-year-old technology."**
**Replaced by**: <modern alternative>
**Migration**: <one concrete step>

When APPROVED:
**Install**: `<ecosystem install command>`
**Note**: <any caveats about the version, semver range, or compatibility>
```

## Skills in scope

- `node-modern` — for Node.js built-in vs. third-party decisions
- `react-modern` — for React version checks
- `typescript-strict` — for TypeScript version alignment
- `security-scanner` — for packages with known CVEs
- `docker-deploy` — for base image version pinning
