# Security Audit — RCE / Insecure Deserialization / Prototype Pollution / Dynamic Loading

Scope: CWE-94/95 (code injection), CWE-502 (insecure deserialization), CWE-1321 (prototype pollution), dynamic code/module loading, untrusted plugin/skill/MCP-tool loading.

Repo: `D:\Codebox\PROJECTS\WrongStack` (WrongStack AI coding-agent CLI, TypeScript/Node monorepo).

Threat actors considered: (a) malicious/compromised MCP server or npm plugin the user installs, (b) prompt-injected model output crafting malicious tool arguments, (c) untrusted YAML/JSON in a repo the agent scans.

---

## Summary

The areas in scope are, with one **Low/Informational** exception, **clean**. The two security-relevant merge sites that touch untrusted data (`config-loader.deepMerge`, `secret-vault.deepMerge`) both carry the `FORBIDDEN_PROTO_KEYS` guard. Tool-input coercion, MCP tool wrapping, the skill loader, and JSON parsing do not introduce prototype-pollution, deserialization, or code-injection sinks. No `eval`, dynamic-Function constructor, or `vm.*` usage exists anywhere in `packages/*/src`. No YAML deserialization library is used at all — frontmatter is parsed by a string-only hand parser.

The only finding worth recording is an **architectural / trust-boundary observation** (F-1): user npm plugins are loaded with full Node privileges and no signature/integrity check. This is by-design for an extensibility surface and matches industry norms (it is how VS Code extensions, ESLint plugins, etc. behave), but it is the single largest code-execution trust boundary in the product and is documented below so the risk is explicit.

| ID | Title | CWE | Severity |
|----|-------|-----|----------|
| F-1 | User plugins execute with full Node privileges, no integrity/signature check | CWE-94 / CWE-829 | Low (by-design, document/harden) |
| — | (all other vectors examined) | — | No issue |

---

## F-1 — User plugins load via dynamic `import(spec)` with full privileges and no trust check

- **CWE:** CWE-94 (Code Injection) / CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)
- **Severity:** Low (intended extensibility surface; documented for completeness)
- **Location:** `packages/cli/src/wiring/plugins.ts:151` — `const mod = (await import(spec)) as { default?: Plugin };`

### Explanation
User plugins are listed in `config.plugins` (loaded from `~/.wrongstack/config.json` and project `.wrongstack` config) and resolved with a raw dynamic `import(spec)`, where `spec` is the plugin package name/path. The imported module's top-level code and its `setup(api)` run with the full privileges of the CLI process — there is no sandbox, no signature verification, no allowlist, and no integrity pin.

This is the expected model for a plugin system and the attacker must already be able to write the user's config or convince the user to install a package. It is **not** remotely triggerable and **not** reachable by a prompt-injected model (the model cannot edit `config.plugins`). The memory note "official plugins get bare names + override; external plugins namespaced-only; officiality set by load source" was assessed: officiality (`official: builtinPlugins.includes(plugin)` at `plugins.ts:185`) is decided purely by whether the plugin object came from the in-process `BUILTIN_PLUGIN_FACTORIES` array, not from any attacker-controllable field. That trust determination is **sound** — a user plugin cannot forge `official` status to claim bare slash-command names or override built-ins, because identity is checked by object reference against the hard-coded builtin set. The capability-enforcement wrapper (`loader.ts:wrapApiForCapabilityCheck`) further gates `tools/providers/slashCommands/mcp` registration, though it is log-only unless `enforceCapabilities` is set.

The residual risk is simply that *installing* a malicious plugin = arbitrary code execution. That is inherent to plugins-as-npm-packages.

### Remediation (hardening, optional)
- Document clearly that installing a third-party plugin grants it full process privileges.
- Optionally support an integrity pin (e.g. expected `version`/hash in config) and warn on first load of a never-seen plugin.
- Consider defaulting `enforceCapabilities: true` so a plugin that under-declares its capabilities is rejected rather than merely logged.

---

## Areas examined and found clean

### 1. Dynamic code execution primitives — none present
`grep` across `packages/*/src` for `eval`, dynamic-Function construction, and `vm.`: **zero** hits in source. `createRequire` appears only in `boot.ts`, `index.ts`, `update-check.ts`, `version.ts` and is used to load the package's own `package.json` for version display — the argument is a static literal path, not attacker-influenced. All other `import(...)` occurrences are either static internal `@wrongstack/*` module specifiers or the documented plugin loader (F-1).

### 2. Tool-input coercion — `packages/providers/src/_tool-input.ts` (recently changed)
`parseToolInput` parses model-produced tool-call argument strings via `safeParse` (plain `JSON.parse`) and returns the result typed `Record<string, unknown>`. No merge, no mass-assignment, no reviver. A `__proto__` key embedded in the JSON arguments becomes a normal own (non-pollution) property of the parsed object — `JSON.parse` never walks the prototype setter — and the object is handed to a tool's `execute(input)`, which indexes named fields. The `completePartialObject` salvage logic only appends `}` / `"` characters to truncated strings; it cannot synthesize a pollution gadget. **No type-confusion or prototype-pollution sink.** (Prompt-injected model output is the relevant actor here and is contained.)

### 3. Prototype-pollution at merge/assign sites
- `packages/core/src/storage/config-loader.ts:97` `deepMerge` — **guarded**: `if (FORBIDDEN_PROTO_KEYS.has(k)) continue;` with the full key set (`__proto__`, `constructor`, `prototype`, `__defineGetter__`, …). This is the site that merges untrusted on-disk config (global + local + env + CLI).
- `packages/core/src/security/secret-vault.ts:297` `deepMerge` — **guarded** with the same `FORBIDDEN_PROTO_KEYS` set (per provided context; confirmed present).
- `packages/cli/src/utils.ts:19` / `packages/webui/src/server/boot.ts:65` `patchConfig` — shallow spread `{ ...base, ...patch }`. Object spread does **not** copy `__proto__` as a prototype mutation, and `patch` is internally constructed (provider/model/yolo flags), not raw untrusted JSON. Safe.
- `packages/core/src/plugin/loader.ts:shallowMerge` — iterates `Object.keys(ov)` (which excludes `__proto__`) writing into a fresh `out` object; `out['constructor'] = ...` would only shadow on the local object, no global pollution. Inputs are plugin defaultConfig + user plugin options. Safe.
- `packages/plugins/src/json-path/index.ts:182` `deepMerge` (the `json_merge` tool, operating on potentially untrusted JSON/YAML data) — uses `Object.keys()` and writes into a fresh `result` object. **Empirically verified** (Node PoC): a patch of `{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":true}}}` merged via this function leaves `({}).polluted === undefined` and `({}).p2 === undefined`. `Object.keys` surfaces `__proto__`/`constructor` as own keys from a `JSON.parse`d object, but assigning them onto a fresh plain `result` object only sets own/local-prototype properties — no global `Object.prototype` pollution. The merged object is returned as tool output, never used to construct or mass-assign. Safe.

### 4. MCP tool injection / namespace escape — `packages/mcp/src/wrap-tool.ts`
A server's tools are wrapped with `name = mcp__<serverName>__<mcpTool.name>`. The qualified name is a plain template string. Registration into `ToolRegistry` (`packages/core/src/registry/tool-registry.ts`) is collision-safe by construction:
- `register()` **throws** on duplicate names; `registerAll()`/`tryRegister()` **skip** duplicates (first-wins). A malicious MCP tool named to collide with a builtin therefore cannot silently replace it — the builtin (registered first at boot) wins, and the colliding MCP tool is dropped.
- `override()`/`wrap()` require the name to already exist and are only invoked by host/plugin code, not by MCP tool definitions.
- Even a server crafted to embed `/`, `__`, or path-like characters in its name only changes the string key; it cannot escape into a builtin's slot because the slot is already occupied. The tool's `execute` simply forwards `input` to `client.callTool` — no code-eval, no merge.
The MCP transport itself uses JSON-RPC over stdio/SSE/HTTP and `JSON.parse`s responses without revivers (no deserialization gadget).

### 5. Skill loader — `packages/core/src/execution/skill-loader.ts`
Skills are discovered from project/user/bundled dirs and only `SKILL.md` files are read. Frontmatter is parsed by a **hand-rolled string parser** (`parseFrontmatter`) constrained to a fixed `Frontmatter` shape; values are always strings. The key is matched by `^([a-zA-Z_]+):` and written `out[key] = stringValue`. Setting `out['__proto__'] = '<string>'` is a no-op for pollution (string assignment to `__proto__` does not mutate the prototype — verified), and `out` is a transient object discarded after `name`/`description`/`version` are extracted. **No YAML deserialization, no code execution** — a skill is loaded as Markdown text injected into the prompt, never executed as code. (Untrusted-repo actor is contained.)

### 6. JSON parsing — `packages/core/src/utils/json-repair.ts` & `utils/safe-json.ts`
- `completePartialObject` / `sanitizeJsonString` only manipulate the raw string (close braces/quotes, strip comments, escape control chars) before a final `JSON.parse`. No reviver, no merge.
- `safeParse` is `JSON.parse` with a byte-length cap. `JSON.parse` without a reviver cannot pollute `Object.prototype` even when the input literally contains a `"__proto__"` key (it becomes a normal own property). No CWE-502 surface (no code-evaluating or function-reconstructing deserializer anywhere).

### 7. YAML — not used
No `js-yaml` / `yaml` deserialization library is imported anywhere in `packages/*/src`. All "yaml" occurrences are lockfile-name detection (`pnpm-lock.yaml`, `pnpm-workspace.yaml`) or path string matching. There is therefore no unsafe `yaml.load` / `!!js/function` deserialization vector.

---

## Method notes
- DFMT `dfmt_exec` (node PoC) was **denied by sandbox policy**; per project policy this fallback to native `Bash` is announced here. The prototype-pollution reachability PoC for `json-path/deepMerge` and `__proto__` bracket assignment was run via native `node -e` and confirmed no global pollution.
- Verification was reachability- and trust-boundary-based: each candidate sink was traced to its actual data source (internal-constructed vs. untrusted config/model/MCP/repo input) before judging severity.
