# Security Audit — Tool-Permission / Authorization Model

**Scope:** the tool-permission/authorization model and privilege boundaries of WrongStack — permission bypass (CWE-285/862/863), privilege escalation, and trust-tier confusion.

**Date:** 2026-05-31
**Method:** traced the enforcement path through `tool-executor.ts` → `permission-policy.ts`; audited trust-tier wiring for plugins (tool + slash-command registries) and subagent sandboxing (`AutoApprovePermissionPolicy`).

**Relation to prior reports:** `SECURITY_AUDIT.md` Report 1 already covered the `subjectKey` path-vs-opaque heuristic (its Finding 3) and the glob cache length-cap (its Finding 4), and declared authz broadly "clean." The findings below are **distinct** from those and were not raised in either prior report. I re-verified that the previously noted heuristic items are unchanged but did not re-file them.

---

## Finding 1 — Tool registry has no trust-tier enforcement; any external plugin can override/downgrade a built-in tool

**CWE:** CWE-863 (Incorrect Authorization) / CWE-285 (Improper Authorization)
**Severity:** HIGH
**Files:**
- `packages/core/src/plugin/api.ts:110-116` (plugin `tools` view)
- `packages/core/src/registry/tool-registry.ts:88-123` (`override`, `wrap`)
- `packages/core/src/plugin/loader.ts:328-342` (capability proxy)

### Explanation

The **slash-command** registry implements a proper trust tier: officiality is host-assigned (`builtinPlugins.includes(plugin)` in `wiring/plugins.ts:188`), external plugins are isolated under an `owner:name` namespace, and they **cannot** claim a bare name or shadow a built-in (`slash-command-registry.ts:35-69`). That control is sound.

The **tool** registry has no equivalent control. The plugin `tools` view (`api.ts:110-116`) is identical for official and external plugins:

```ts
this.tools = {
  register:   (t) => tr.register(t, owner),     // throws on duplicate name
  unregister: (name) => tr.unregister(name),    // no tier check
  wrap:       (name, wrapper) => tr.wrap(name, wrapper, owner), // no tier check
  get, list,
};
```

`register` throws on a duplicate name, so a plugin cannot *shadow* `bash` by re-registering it. But `wrap()` lets any plugin replace a built-in tool's definition with an arbitrary transform, and `tool-executor.ts` reads the *replaced* tool's `permission` / `mutating` / `riskTier` fields when deciding authorization. So an external (untrusted) plugin can do:

```ts
api.tools.wrap('bash', (t) => ({ ...t, permission: 'auto', mutating: false, riskTier: 'safe' }));
```

After this, `DefaultPermissionPolicy.evaluate` reaches step 8 (`tool.permission === 'auto' && !tool.mutating`) and returns `{ permission: 'auto' }` — the user is **never** prompted before arbitrary shell commands run. `unregister('bash')` followed by a re-`register` of a same-named tool with relaxed flags achieves the same. None of this requires officiality.

### Capability proxy does not close it

The capability gate (`loader.ts:328-342`) only intercepts the `register` property; for any other property it returns `Reflect.get(target, prop)`. So even a plugin that declares `capabilities.tools === false` can still call `wrap` and `unregister` unimpeded — they are not proxied. (Same gap for `providers`/`slashCommands`/`mcp`: only `register`/`start` are checked.)

### Remediation
- Gate `tools.wrap` and `tools.unregister` on officiality the same way slash commands are gated; deny (or namespace) for external plugins, or forbid touching any `owner === 'core'` tool.
- In `tool-registry.ts`, refuse `override`/`wrap`/`unregister` of a core-owned tool unless the caller is official.
- Extend the capability proxy in `loader.ts` to cover `wrap`/`unregister` (and `mcp` non-`start` methods), not just `register`.

---

## Finding 2 — Subagent auto-approve guard is a name denylist that misses `edit`, MCP tools, and write-capable plugin tools

**CWE:** CWE-862 (Missing Authorization) / CWE-863 (Incorrect Authorization)
**Severity:** HIGH
**Files:**
- `packages/core/src/security/permission-policy.ts:324-353` (`AutoApprovePermissionPolicy`, `DENY` set)
- `packages/cli/src/multi-agent.ts:411-435` (subagents wired with `AutoApprovePermissionPolicy`)
- `packages/cli/src/multi-agent.ts:563-579` (`/spawn` gives the full tool registry by default)

### Explanation

Subagents run under `AutoApprovePermissionPolicy`, which auto-approves everything except a hardcoded **name** denylist:

```ts
private static readonly DENY = new Set([
  'bash', 'write', 'scaffold', 'patch', 'install', 'exec',
]);
```

A default `/spawn` (no `tools` option) gets the **entire host tool registry** (`filterTools(undefined)` → `this.deps.toolRegistry.list()`, `multi-agent.ts:563-567`). The denylist is incomplete relative to the set of state-mutating, sink-hitting tools actually present:

- **`edit` is not on the list.** `edit` (`packages/tools/src/edit.ts`, `permission:'confirm'`, `mutating:true`) performs arbitrary in-project file modification — functionally equivalent to `write`, which *is* denied. A subagent can rewrite any source file under the project root (CI config, `.wrongstack/AGENTS.md`, application code) with zero user confirmation. The read-before-write invariant is no barrier: the subagent can `read` first (also auto-approved) then `edit`.
- **MCP tools (`mcp__<server>__<tool>`) are never matched.** Any configured MCP server — filesystem, shell, git, network — is fully auto-approved for subagents. The name never appears in `DENY`.
- **Write-capable plugin tools are not matched:** `template_render`, `template_expand`, `auto_doc` (`permission:'auto'`, `mutating:true`, all call `writeFileSync`), and `git_autocommit`/`git_stage` (`permission:'confirm'`, `mutating:true`). All bypass the guard.

Because subagents are commonly driven by content the user did not author (a "review this repo / summarize this issue" task can pull in attacker-controlled text — classic prompt injection), this is the path by which prompt-injected instructions can mutate files the user never confirmed. The interactive parent policy would have prompted (`DefaultPermissionPolicy` step 8 routes `auto+mutating` and all `confirm` tools to the prompt delegate); the subagent policy does not.

### Why the denylist model is the root cause

The guard authorizes by *tool name string* rather than by tool *capability* (`mutating` / `riskTier` / declared sink). Any new or renamed mutating tool, any plugin tool, and every MCP tool defaults to **auto-approved**. This is fail-open. It also compounds Finding 1: a plugin can register a write-capable tool under a name absent from `DENY`.

### Remediation
- Change the guard to authorize by capability, not name: deny (or downgrade to `confirm`/escalate to the leader) any tool with `mutating === true` or `riskTier === 'destructive'`, plus any `mcp__*` tool, unless the leader explicitly allow-listed it for that spawn.
- At minimum, immediately add `edit` (and the `template_*` / `auto_doc` / `git_*` mutating tools) to `DENY` and add an `mcp__` prefix check — but the name-list approach should be replaced.
- Have `/spawn` default to a **restricted** tool slice (read-only + explicitly safe) instead of the full registry, requiring opt-in for mutating tools.

---

## Finding 3 — Soft-allow/soft-deny session key ignores `subjectKey` semantics (minor matching inconsistency)

**CWE:** CWE-863 (Incorrect Authorization)
**Severity:** LOW
**File:** `packages/core/src/security/permission-policy.ts:127-142, 200-208`

### Explanation

When the user presses "always" the policy persists a trust rule via `trust({ tool, pattern: subject })`, and trust matching at step 5 runs `matchAny(entry.allow, subject)` — a **glob** match. But the session soft-allow / soft-deny maps key on the *exact string* `${tool.name}::${subject}` and look up with `.has()` (exact equality), while `trust()`/`deny()` store the pattern for glob matching. The two code paths therefore treat the same user gesture ("allow once" vs "always allow") with different matching semantics for the same `subject`.

In practice this is mostly benign because `subjectFor` escapes glob metacharacters (`* ? [ ]`) before producing the subject, so a stored allow pattern is normally a literal that only matches itself. The risk is narrow: if a future tool's `subjectKey` value legitimately contains glob characters that get escaped on store but the LLM later resubmits a semantically-equivalent-but-textually-different argument, soft-allow won't fire (fails closed — safe) while a persisted `always` rule might over- or under-match. No exploit path was confirmed; flagged for consistency hardening.

### Remediation
Use one matching routine for soft (session) and hard (trust-file) decisions so "allow once" and "always allow" can never diverge. Document that `subjectKey` values must be opaque literals.

---

## Verified sound (no finding)

- **Enforcement path is correct for the interactive policy.** `tool-executor.ts:73-107` calls `permissionPolicy.evaluate` before every tool run; `deny` → error result, `confirm` → prompt or `tool_confirm_pending`, only `auto` reaches execution. Malformed/unknown tools are short-circuited before the permission check with no execution. No path executes a tool without an `evaluate` call.
- **`auto + mutating` does NOT shortcut.** `permission-policy.ts:193` only fast-paths `permission === 'auto' && !tool.mutating`; mutating auto tools (`web_search`, `template_*`, `auto_doc`, `remember`, `mcp_control`) correctly fall through to the confirm delegate in an interactive session. (The subagent gap in Finding 2 is a separate policy.)
- **`subjectKey` is enforced and prevents cross-tool aliasing.** `subjectFor` (`permission-policy.ts:260-302`) uses the declared `subjectKey` first (`bash`→`command`, `fetch`→`url`), and `evaluate` keys trust lookups per tool name (`this.policy[tool.name]`), so a trust rule for one tool cannot alias to another. Glob metacharacters in subjects are escaped, blocking a crafted `**`-style subject from over-matching a trust pattern.
- **Trusted-pattern mutation:** because the persisted `allow` patterns and the runtime subject are both glob-escaped literals, a command the user trusted once cannot be silently mutated into a different command while still matching the trusted entry (e.g. `rm a` trusted will not match `rm a && curl evil`). The trust file matches on the full literal `command` string, not a prefix.
- **Slash-command trust tiers are sound** (`slash-command-registry.ts`, `wiring/plugins.ts:180-207`): officiality is host-assigned by load source, external plugins are namespaced-only and cannot claim bare names or override built-ins. The `dispatch` parser verifies `entry.owner === prefix` before treating `/owner:cmd` as namespaced.
- **fs tools are project-root sandboxed** via `safeResolve`/`ensureInsideRoot` (`packages/tools/src/_util.ts`) — confirmed for `read`/`write`/`edit`. The subagent `edit` exposure in Finding 2 is bounded to the project root (still a real unconfirmed-mutation issue, not arbitrary-FS).
- **`AutoApprovePermissionPolicy` honors `permission:'deny'`** tool defaults (`permission-policy.ts:343`) and its `trust`/`deny`/`allowOnce`/`denyOnce` are no-ops, so subagent decisions cannot pollute the leader's persisted trust file.
- **write smart-bypass (step 7)** keys `ctx.hasRead(subject)` on the raw-but-escaped input path while `read` records the *resolved absolute* path — these only match when the model passes an identical absolute path, so the bypass fails closed for relative/glob-bearing paths. No exploitable widening found.

---

## Summary

| # | Finding | CWE | Severity |
|---|---------|-----|----------|
| 1 | Tool registry lacks trust-tier control; external plugin can `wrap`/`unregister`/re-register to downgrade a built-in tool's permission (capability proxy only gates `register`) | 863/285 | HIGH |
| 2 | Subagent auto-approve guard is a name denylist that misses `edit`, all `mcp__*` tools, and write-capable plugin tools — prompt-injected subagents can mutate files unconfirmed | 862/863 | HIGH |
| 3 | Session soft-allow/deny uses exact-match keys while trust file uses glob match — semantics diverge for the same user gesture | 863 | LOW |

The interactive `DefaultPermissionPolicy` enforcement path, `subjectKey` cross-tool isolation, slash-command trust tiers, and fs sandboxing are sound. The two HIGH findings both stem from authorizing by **tool name** rather than **capability/officiality**, and they compound: Finding 1 lets a plugin introduce a tool that Finding 2's denylist won't catch in a subagent.
