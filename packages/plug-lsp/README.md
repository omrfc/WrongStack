# @wrongstack/plug-lsp

Language Server Protocol tools for WrongStack.

This package is implemented as a WrongStack monorepo plugin and reads its
configuration from `extensions["@wrongstack/plug-lsp"]`.

```json
{
  "features": { "plugins": true },
  "plugins": ["@wrongstack/plug-lsp"],
  "extensions": {
    "@wrongstack/plug-lsp": {
      "autoStart": "lazy",
      "servers": {
        "typescript": {
          "command": "typescript-language-server",
          "args": ["--stdio"],
          "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
          "rootPatterns": ["tsconfig.json", "jsconfig.json", "package.json"]
        }
      }
    }
  }
}
```

Registered tools:

- `lsp_diagnostics`
- `lsp_definition`
- `lsp_references`
- `lsp_hover`
- `lsp_symbols`
- `lsp_rename`
- `lsp_code_actions`

Plugin slash commands are namespaced by the current WrongStack command
registry, for example `/@wrongstack/plug-lsp:list`.

## Installing language servers

The plugin is an LSP client. Language server binaries can be installed into the
project instead of relying on global PATH state:

```sh
pnpm --filter @wrongstack/plug-lsp build
pnpm --filter @wrongstack/plug-lsp setup -- --cwd /path/to/project
```

After setup, `autoDiscover` checks both PATH and project-local
`node_modules/.bin`, so the same flow works on Windows, macOS, and Linux.

Default setup installs npm-based servers for TypeScript/JavaScript, Python,
JSON, HTML, CSS, YAML, and shell scripts. Extra toolchain-backed servers can be
requested explicitly:

```sh
wrongstack-lsp-setup --languages typescript,python,go,rust,ruby
```
