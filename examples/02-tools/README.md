# 02 — Tool Usage

Examples demonstrating WrongStack's built-in tools.

## File editing

```bash
wrongstack "rename the function `getData` to `fetchData` everywhere in src/"
wrongstack "add error handling to the try/catch block in src/api.ts"
wrongstack "convert all var declarations to const/let in src/utils/"
```

## Code search

```bash
wrongstack "find all TODO comments in the codebase"
wrongstack "which files import from @wrongstack/core?"
wrongstack "find unused exports in src/index.ts"
```

## Git operations

```bash
wrongstack "what changed in the last 5 commits?"
wrongstack "create a commit with all staged changes, conventional commit format"
wrongstack "show me the diff between main and the current branch"
```

## Running tests

```bash
wrongstack "run the test suite and fix any failures"
wrongstack "add a test for the parseArgs function in arg-parser.ts"
wrongstack "run tests for the permission-policy module only"
```

## Project scaffolding

```bash
wrongstack "create a new TypeScript utility file for string manipulation"
wrongstack "generate a GitHub Actions workflow for CI"
wrongstack "scaffold a new npm package in packages/my-plugin"
```

## Dependency management

```bash
wrongstack "check for outdated dependencies"
wrongstack "audit for security vulnerabilities"
wrongstack "add vitest as a dev dependency"
```
