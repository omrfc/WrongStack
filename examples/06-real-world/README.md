# 06 — Real-World Workflows

Practical workflows for daily development.

## Refactor a module

```bash
wrongstack "refactor src/auth.ts to use async/await instead of callbacks. Keep the same API surface."
```

The agent will:
1. Read the file
2. Understand the current pattern
3. Propose changes
4. Apply edits (with confirmation, or auto in YOLO mode)
5. Run tests to verify

## Debug a failing test

```bash
wrongstack "the test 'should handle timeout' is failing in src/timeout.test.ts. Find and fix the root cause."
```

## Code review

```bash
wrongstack "review the changes in the last commit. Focus on security and error handling."
```

Or switch to a specialized mode:

```
/use code-reviewer
> review src/api.ts
```

## Add tests to uncovered code

```bash
wrongstack "add unit tests for the parseArgs function. Cover edge cases: empty input, unknown flags, mixed positional and flags."
```

## Security audit

```bash
wrongstack "scan this project for hardcoded secrets, SQL injection vectors, and path traversal vulnerabilities."
```

Or with the security-scanner skill:

```
/spawn --role security-scanner "full security audit of packages/"
```

## Dependency update

```bash
wrongstack "check for outdated packages, assess breaking change risk, and update safe ones."
```

## Generate documentation

```bash
wrongstack "add JSDoc comments to all exported functions in packages/core/src/kernel/"
```

## Conventional commit

```bash
wrongstack "stage all changes and create a conventional commit message"
```

## Migration guide

```bash
wrongstack "this project migrated from Express to Fastify. Write a migration guide covering the key changes."
```

## Performance profiling

```bash
wrongstack "identify the slowest functions in src/ and suggest optimizations. Focus on hot paths."
```

## CI/CD setup

```bash
wrongstack "create a GitHub Actions workflow that runs lint, typecheck, and tests on PRs. Include a release workflow for npm publish."
```

## Monorepo maintenance

```bash
wrongstack "check that all workspace packages have consistent versions and that cross-package dependencies are up to date."
```

## Combine with flags

```bash
# Fast iteration: TUI + YOLO + specific provider
wrongstack --tui --yolo --provider groq --model llama-3.3-70b-versatile \
  "add error boundaries to all React components in src/"

# Director + goal for large autonomous tasks
wrongstack --director --goal "migrate all tests from Jest to Vitest"

# Offline mode
wrongstack --no-features --provider anthropic --model claude-opus-4-7 \
  "explain the kernel architecture"
```
