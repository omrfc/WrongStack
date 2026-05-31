# Supply-Chain, CI/CD & Build-Script Security Audit — WrongStack

**Scope:** CWE-1104/937 (unmaintained/vulnerable components), CWE-94 (GitHub Actions script injection), GitHub Actions misconfiguration, build/release script safety.
**Date:** 2026-05-31
**Method:** `pnpm audit --json` (succeeded, network reachable), manual review of all `package.json`, `pnpm-lock.yaml` spot-check of security-sensitive deps, all three workflows, and every build/release script.

---

## Dependency Posture (summary)

- **`pnpm audit --json` result: 0 advisories** across 591 total resolved deps (213 prod, 378 dev, 111 optional). info/low/moderate/high/critical all 0.
- **Internal deps use `workspace:*`** — correct for a monorepo; no version drift between packages (all at `0.9.15`, kept in sync by `scripts/bump-version.mjs`).
- **External runtime deps are minimal and current.** Security-sensitive third-party packages resolve to up-to-date, non-vulnerable versions:
  | Package | Range declared | Resolved (lockfile) | Notes |
  |---|---|---|---|
  | `undici` | `^7.25.0` (tools), `^6.21.0` (mcp dev) | `7.25.0`, `6.25.0` | Current; no open advisories. HTTP client. |
  | `ws` | `^8.20.1` (cli), `^8.18.0` (webui) | `8.20.1` | Current; CVE-2024-37890 (DoS) fixed in 8.17.1. OK. |
  | `vite` | `^6.0.7` (webui), `^6.0.5` (website) | `6.4.2` / `7.3.3` | Current; well past the 6.0.9/6.0.11 `server.fs` advisories. Build-time/dev only. |
  | `esbuild` | (transitive, via tsup/vite) | `0.25.12`, `0.27.7` | Past the `<=0.24.2` dev-server CORS advisory (GHSA-67mh-4wv8-2f99). |
  | `react`/`react-dom` | `^18`/`^19` | `18.3.1`, `19.2.6` | Current. |
  | `ink` | `^5.0.1` | `5.2.1` | Current. |
  | `zustand` | `^5.0.2` | `5.0.13` | Current. |
  | `vscode-languageserver-protocol` | `^3.17.5` | `3.17.5` | Stable, maintained by Microsoft. |
- **No native-addon / build-script-heavy deps that aren't allow-listed.** `pnpm-workspace.yaml` uses `onlyBuiltDependencies: [@biomejs/biome, better-sqlite3, esbuild]` — pnpm 11 blocks lifecycle scripts for everything else by default, which is the **correct, secure default** (mitigates malicious-postinstall supply-chain attacks). Note `better-sqlite3` is allow-listed for build but is **not declared in any current `package.json`** in the tree — a stale allow-list entry, harmless but worth pruning.
- **Version ranges are caret (`^`) throughout**, not exact pins. Acceptable for a library/CLI publisher (consumers get patches), and the **committed `pnpm-lock.yaml` + `--frozen-lockfile` in CI** is what actually pins what gets built/published. This is the right model. The published packages ship only `dist/` (`files` field), so consumers resolve their own transitive tree against these caret ranges.
- **No `resolutions`/`overrides`** block — nothing is being force-pinned to patch a transitive vuln, which is fine given the clean audit.

Overall dependency posture: **strong.** Clean audit, minimal external runtime surface (effectively just `undici`, `ws`, `ink`/`react`, radix-ui, `vscode-languageserver-protocol`), lifecycle scripts locked down by default.

---

## Findings

### F1 — `postinstall` reconfigures git hooks path on every install
- **Category:** Supply-chain / build-script behavior (CWE-1104 adjacent; trust-on-install)
- **Severity:** Low (Informational)
- **Location:** `package.json:29` — `"postinstall": "git config core.hooksPath .githooks"`
- **Explanation:** The root manifest runs `git config core.hooksPath .githooks` on `postinstall`. This is benign for *this* repo's own contributors (it wires up the corruption-guard pre-commit hook), and because the root package is `private: true` it is never published, so downstream `npm i wrongstack` consumers never run it. The hook target `.githooks/pre-commit` only invokes `node scripts/guard-against-corruption.mjs` (reviewed — read-only scanning, see F3). Risk is limited to: (a) anyone running `pnpm install` in a clone silently has their per-repo hooks path repointed (expected for contributors but undocumented as a side effect), and (b) if `.githooks/` content were ever malicious it would execute on the next commit. Since the script is in-repo and reviewed, this is informational, not a vuln.
- **Remediation:** Optional. Keep, but document in CONTRIBUTING that `pnpm install` sets `core.hooksPath`. Consider gating behind `setup:hooks` (already exists) rather than auto-running on install, so CI/sandboxed installs don't mutate git config.

### F2 — `release`/`release:dry` use `--no-git-checks` (and `--force` on dry-run)
- **Category:** Release-process safety (CWE-draft / publish hygiene)
- **Severity:** Low
- **Location:** `package.json:26-27`
  - `"release:dry": "pnpm publish -r --dry-run --no-git-checks --force"`
  - `"release": "pnpm release:check && pnpm publish -r --access public --no-git-checks"`
- **Explanation:** `--no-git-checks` disables pnpm's guard that refuses to publish from a dirty/branch-mismatched working tree. The *local* `release` script could therefore publish uncommitted changes if run by hand. **However**, the authoritative release path is the **`release.yml` workflow** (tag-triggered, runs on a clean checkout, verifies tag==version, publishes with `--provenance`), so the local script is a convenience/fallback, not the production publish path. The CI publish is the trustworthy one. Real risk is only "a maintainer fat-fingers a manual `pnpm release` with a dirty tree."
- **Remediation:** Prefer the CI tag-driven release exclusively; if the local script is kept, drop `--no-git-checks` (or add a clean-tree assertion) so manual publishes can't ship uncommitted code.

### F3 — Build/release helper scripts shell out, but only with hardcoded/internal input (no injection)
- **Category:** Command injection review (CWE-78 / CWE-94) — **NOT vulnerable**
- **Severity:** Informational (verified safe)
- **Locations & analysis:**
  - `release-helper.mjs:24-41` — uses Node `child_process` with a shell. The only interpolated value is `f`, drawn from a **hardcoded file array** (`release-helper.mjs:7-22`); the commit message and tag are string literals (`"release 0.8.5"`, `v0.8.5`). No external/untrusted input reaches the shell. Safe. (Style note: the repo provides a safer `execFileNoThrow` helper; this one-off release script predates/ignores it but is not reachable by untrusted input.)
  - `cleanup.cjs:2` — `fs.unlinkSync` over a **hardcoded list** of scratch filenames; no shell, no input. Safe (one-off dev cleanup of `check-*.cjs` scratch files).
  - `scripts/bump-version.mjs` — pure Node fs/JSON; the `set <version>` arg is validated against `/^\d+\.\d+\.\d+/` (`bump-version.mjs:63`) before use, and is only written into a JSON `version` field, never shelled. Safe.
  - `scripts/guard-against-corruption.mjs` — runs `git diff --cached` / `git status` via `execSync` with **no interpolated arguments** (`:21`, `:72`); only reads file contents and string-matches a corruption fragment. Read-only, no destructive ops. Safe.
  - `scripts/install.sh` / `install.ps1` — pipe-to-shell installers. `WRONGSTACK_VERSION`/`WRONGSTACK_MANAGER` env vars are interpolated into the install command. These run **on the end-user's own machine with their own env**, so an attacker setting these would only be attacking themselves; not a server-side/CI injection. `set -euo pipefail` is used. Acceptable for an installer; minor hardening would be to validate `WRONGSTACK_VERSION` matches a semver pattern before the global install.
  - `release.sh:1` — `cd /d D:\Codebox\PROJECTS\WrongStack` is a **Windows `cmd` line in a `.sh` file** (the `/d` flag is `cmd`'s, not bash's). Harmless but broken-as-bash; cosmetic.
- **Remediation:** None required for safety. Optionally add semver validation to the installer env vars and fix the `release.sh` shebang/CWD mismatch.

---

## CI/CD Review — all clean (positive findings)

No vulnerabilities found. Notable good practices confirmed:

- **No `pull_request_target` and no `workflow_run`** anywhere (`grep` confirmed). CI uses plain `pull_request` (`.github/workflows/ci.yml:6`), which runs in the fork's untrusted context **without** access to repo secrets — correct. There is no checkout-of-untrusted-PR-then-run-with-secrets pattern.
- **No `${{ github.event.* }}` interpolation into `run:` steps** — the only `github.*` use is `GITHUB_REF_NAME` via shell env in `release.yml:52` (`${GITHUB_REF_NAME#v}`), which is a git ref name (constrained by the `v*` tag filter), and `steps.version.outputs.VERSION` compared against package.json in `release.yml:54-62`. No script-injection (CWE-94) vector.
- **All third-party actions are pinned to full commit SHAs**, not mutable tags/branches, with a comment recording the major tag + resolution date:
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5` (ci.yml:35, pages.yml:34, release.yml:26)
  - `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1` (ci.yml:40, release.yml:29)
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`
  - `actions/configure-pages@983d7736...`, `actions/upload-pages-artifact@56afc609...`, `actions/deploy-pages@d6db9016...` (pages.yml)
  - `softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` (release.yml:73)
- **Least-privilege `GITHUB_TOKEN`:** every workflow declares top-level `permissions: contents: read` (ci.yml:12-13, pages.yml:17-21 adds only `pages: write`/`id-token: write`, release.yml:11-13). The release **gate job** narrows-up to `contents: write` + `id-token: write` only where needed (release.yml:21-23). No `write-all`, no broad token.
- **npm publish secret handling is sound:** `NPM_TOKEN` is referenced only as `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` in the publish step (release.yml:70), in a **tag-push-triggered** workflow (release.yml:3-6) that never runs on fork PRs — so the token is never exposed to untrusted PR code. Publish uses `--provenance` with `id-token: write` (release.yml:64-68) for signed build attestation. Tag/version are verified to match before publishing (release.yml:54-62).
- **`pnpm install --frozen-lockfile`** in CI and release (ci.yml:48, release.yml:37) — prevents lockfile drift / silent dependency substitution at build time.
- **pnpm version** comes from `packageManager` field with an integrity `sha512` hash (`package.json:7`), so the package manager itself is integrity-checked.
- **Concurrency guard on Pages** prevents half-applied deploys (pages.yml:24-26).

Minor observation (not a finding): `node-version: 22` (ci/pages/release) pins only the major; a patch-level pin or `.nvmrc` would make builds more reproducible, but Node majors are a reasonable trust boundary.

---

## Summary table

| ID | Title | Category | Severity |
|----|-------|----------|----------|
| F1 | `postinstall` repoints git hooks path | Supply-chain / install side-effect | Low (info) |
| F2 | `release`/`release:dry` use `--no-git-checks` | Release hygiene | Low |
| F3 | Build/release scripts shell out (hardcoded input only) | CWE-78/94 review | Informational (safe) |

No High/Critical/Moderate issues. Dependency posture is strong (clean `pnpm audit`, current sensitive deps, lifecycle scripts locked by pnpm allow-list). CI/CD is well-hardened (SHA-pinned actions, least-privilege tokens, no `pull_request_target`, no script-injection sinks, frozen lockfile, provenance publish).
