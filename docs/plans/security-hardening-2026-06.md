# Security Hardening Plan — 2026-06

**Based on:** Full `security-check` rescan (June 2026)
**Source Report:** historical security-report scan artifacts (not committed); current source of truth is `SECURITY.md`.
**Current Posture:** Strong — 0 Critical/High/Medium findings. All prior issues (F-01, F-02, F-03) verified fixed. Overall risk **LOW**.
**Owner:** Maintainers + security-conscious contributors

---

## Executive Summary

The June 2026 full security rescan (using the external `security-check` 4-phase pipeline) confirmed that WrongStack has an excellent security posture for a high-privilege local AI coding agent. The explicit adversarial-LLM threat model in `SECURITY.md` is working well in practice.

The only remaining items are **informational hardening opportunities** (no blocking vulnerabilities):

1. **Short-term (Implemented):** Keep `pnpm audit` as an explicit gate.
2. **Medium-term (Architectural):** Evolve authorization decisions from name-string + denylists toward explicit capability allowlists.
3. **Ongoing (Process):** Institutionalize the excellent `onlyBuiltDependencies` + secret-scrubbing + guarded-egress discipline for future MCP/plugin/tool additions.

This plan turns those recommendations into concrete, prioritized, trackable work.

---

## Prioritized Initiatives

### P0 — Quick Win: Explicit Dependency Audit Gate (Implemented)

**Objective**
Keep supply-chain hygiene as a first-class, enforced gate rather than something that is only run manually.

**Rationale (from report)**
> "Short-term (Recommended) — Add explicit `pnpm audit --audit-level=moderate` step to release gates if not already present."

Current implementation:
- `package.json` → `"release:check": "pnpm audit --audit-level=moderate && pnpm typecheck && pnpm test && pnpm build"`
- CI/release workflow audit gates are tracked as implemented in the progress section below.
- `pnpm-workspace.yaml` already has a good `onlyBuiltDependencies` allowlist.

**Concrete Steps**

1. Keep root `package.json` gated:
   ```json
   "release:check": "pnpm audit --audit-level=moderate && pnpm typecheck && pnpm test && pnpm build"
   ```

2. Keep the dedicated audit step in `.github/workflows/ci.yml`.

3. Keep the same check in `.github/workflows/release.yml` **before** the publish step (blocking).

4. (Optional but nice) Add a weekly scheduled audit workflow that fails + notifies on new advisories.

**Success Criteria**
- `pnpm release:check` fails locally if moderate+ advisories exist.
- Both CI and Release workflows fail the gate on moderate+ advisories.
- Documentation updated in `docs/subcommands/` or `RELEASE.md`.

**Estimated Effort:** 1–2 hours (mostly YAML + one-line script change).

---

### P1 — Architectural: Capability-Based Authorization Model (Defense-in-Depth)

**Objective**
Reduce reliance on fragile name strings and hardcoded denylists. Move toward explicit, declarative capabilities/permissions that are easier to audit and reason about.

**Rationale (from report + verified-findings.md)**
> "Minor evolution opportunity on permission model (allowlists vs current name-based + denylists in some paths)."
> "Continue migrating remaining authorization decisions toward explicit capability allowlists (defense-in-depth)."

Current implementation examples:
- `packages/core/src/security/permission-policy.ts` → `AutoApprovePermissionPolicy.DENY` (hardcoded set of dangerous tool names + `mcp__` prefix check).
- `packages/core/src/plugin/api.ts` → `assertCanMutateTool` (owner-string based + `isOfficial` flag).
- Tool registry mutation methods still have relatively coarse controls.

**Concrete Steps (Phased)**

**Phase 1.1 — Introduce Tool Capability Tags (small, high-leverage)**
- Add an optional `capabilities?: string[]` field to the `Tool` interface (or reuse/extend the existing `category` + new `risk` concept).
- Example capabilities: `["fs.write", "shell.arbitrary", "net.outbound", "mcp.proxy", "subagent.spawn"]`.
- Update `AutoApprovePermissionPolicy` to work primarily off capabilities instead of (or in addition to) exact names.
- Update the subagent guard to be **allowlist by default** for non-dangerous capabilities.

**Phase 1.2 — Strengthen Plugin Mutation Rules**
- Consider adding a `capabilities` declaration requirement for plugins that want to mutate tools they don't own.
- Make the current `isOfficial` path more explicit (capability "tool.mutate.any" or similar).

**Phase 1.3 — Documentation & Migration**
- Document the new capability model in `docs/tool-author-guide.md` and `SECURITY.md`.
- Provide a deprecation path for the old name-based checks.

**Success Criteria**
- The subagent dangerous-tool decision is driven by declared capabilities, not a growing hardcoded `DENY` set.
- Adding a new dangerous tool automatically requires updating its capability declaration (fail-closed by default).
- Reviewers can answer "Does this tool grant `shell.arbitrary`?" from the tool definition alone.

**Estimated Effort:** Medium (2–4 days of focused work + tests + docs). Can be done incrementally.

---

### P2 — Process & Discipline: Future-Proofing New Integrations (Ongoing)

**Objective**
Ensure that the current excellent hygiene (`onlyBuiltDependencies`, secret scrubbing, guarded egress, permission model) does not degrade as the project adds new MCP servers, plugins, or powerful tools.

**Rationale (from report)**
> "Ongoing — Maintain the excellent `onlyBuiltDependencies` + secret-scrubbing + guarded-egress discipline as new MCP servers, plugins, or tools are added."

**Concrete Steps**

1. **Add a short "Security Surface Review" checklist** to:
   - `docs/plugin-author-guide.md`
   - `docs/tool-author-guide.md`
   - `CONTRIBUTING.md` (or a new `docs/security-contributing.md`)

   Checklist items should include:
   - Does this add a new `child_process` / shell surface? → Must go through allowlist or strong validation + permission gate.
   - Does it perform outbound network? → Must use guarded paths where possible.
   - Does it touch the secret vault or env? → Scrubbing review required.
   - Does it introduce new MCP tools? → Subagent guard impact?
   - Does it require changes to `onlyBuiltDependencies` or `allowBuilds` in `pnpm-workspace.yaml`? → Explicit review + justification.

2. **Add a comment block** at the top of `pnpm-workspace.yaml` explaining the security intent of the allowlists.

3. **Consider a lightweight `security-review` label** or required checklist item for PRs that touch `packages/tools`, `packages/mcp`, `packages/plugin*`, or `pnpm-workspace.yaml`.

**Success Criteria**
- Every new tool/MCP/plugin addition after 2026-06 has an explicit security surface note in its PR description or commit.
- `pnpm-workspace.yaml` changes are rare and well-justified.

**Estimated Effort:** Low (documentation + process) + cultural enforcement.

---

### P3 — Accepted Risks / Non-Issues (Close the Loop)

From the report and previous scan:

- **Dev-only `postinstall` git-hooks setup** (`F-09` in prior scan): Maintainer decision. Not a security boundary. Document this explicitly as "accepted" in `SECURITY.md` so future scans don't keep surfacing it.
- Some owner-string based checks that remain for backward compatibility / pragmatism.

**Action:** Add a short "Accepted Risks & Trade-offs" section to `SECURITY.md` referencing the 2026-05 and 2026-06 scans. This prevents alert fatigue on future audits.

---

## Tracking & Execution

- This plan is tracked via the project's internal todo system (see agent todos for `sec-plan-*` items).
- Major items should be broken into GitHub issues or PRs with the label `security` or `hardening`.
- After each significant change, re-run `/security-check` (or at minimum the relevant focused hunters) and update `SECURITY.md` plus any generated scan artifacts.

---

## Current Implementation Status (June 2026 — Full Pass)

**A — Tool Content Quality**
Largely complete. The vast majority of user-facing tools now have high-quality, security-aware, usage-guidance-rich documentation (description + usageHint + detailed schema properties). This directly improves the quality and safety of LLM-driven tool calls.

**B — Invocation Guarantees**
Significant concrete progress:
- Registration-time schema validation (ToolRegistry rejects tools without valid inputSchema at load time).
- Runtime JSON Schema validation on *every* tool call inside ToolExecutor — before permission policy or execution. Invalid calls are rejected with rich, model-actionable errors that include guidance on how to fix the call (e.g. use tool-help).
- Additional capability safety layer at the executor for tools declaring dangerous capabilities.
- Defense-in-depth observability: dangerous capability usage is now visible at the exact invocation point.

These form real, enforceable gates that make incorrect or overly powerful tool calls much harder to succeed accidentally or maliciously.

**Overall**
The combination of dramatically better tool self-documentation + hard runtime gates around schema validity and capability visibility represents a major step forward in the project's security posture for agentic tool use.

**Recommended follow-ups**
- Typed EventBus event for dangerous capability detection.
- Consider capability-allowlist enforcement profiles (beyond current name/denylist approach).
- Add specific tests for the new validation paths.
- Re-audit after any new high-privilege tool or MCP integration.

## References

- Historical security-report scan artifact (not committed)
- Historical verified-findings scan artifact (not committed)
- Historical security architecture scan artifact (not committed)
- `SECURITY.md` (threat model — source of truth)
- `packages/core/src/security/permission-policy.ts`
- `packages/core/src/plugin/api.ts`
- `packages/core/src/registry/tool-registry.ts`
- `.github/workflows/ci.yml` + `release.yml`
- `pnpm-workspace.yaml`

---

**Last updated:** 2026-06 (immediately after full security-check rescan + implementation pass)

## Implementation Progress (June 2026)

**Status:** Both A (Tool Content Quality) and B (Invocation Guarantees) have received substantial work. The project is in a significantly stronger position regarding tool safety and correct usage.

### A — Tool Content Quality (largely complete)
- The vast majority of tools (including meta, planning, execution, filesystem, network, and code-quality tools) received major upgrades to `description`, `usageHint`, and detailed `inputSchema` property documentation. This round completed polishing of several remaining ones (codebase-stats, pack, tool-help schema, logs, etc.).
- Consistent pattern: clear purpose, "when to use vs when not to use", security warnings, recommended workflows, and "prefer X over raw shell" guidance.
- This dramatically improves the chance that the LLM will call tools correctly and safely on its own.

### B — Invocation Guarantees (strong progress)
- **Registration time**: Tools without valid `inputSchema` are rejected at load time.
- **Runtime time**:
  - Full JSON Schema validation on *every* tool call before permission or execution.
  - "Effective permission" calculation that forces `confirm` for tools with dangerous capabilities in normal (non-full-yolo) operation.
  - Rich, model-actionable rejection messages when validation or safety checks fail.
- Capability awareness and post-validation safety checks are now active at the executor layer (defense in depth).
- These multiple independent gates make incorrect, malformed, or overly powerful tool calls significantly harder to succeed.

The following items from this plan have been implemented in detail:

**P0 — Audit Gates**
- ✅ `release:check` now runs `pnpm audit --audit-level=moderate` first.
- ✅ Added blocking audit steps to both `ci.yml` and `release.yml`.

**P1 — Capability Model (Initial Wave)**
- ✅ Added `capabilities?: readonly string[]` to the `Tool` interface.
- ✅ Created `packages/core/src/security/capabilities.ts` with well-known capabilities + `DANGEROUS_FOR_SUBAGENTS`.
- ✅ `AutoApprovePermissionPolicy` is now **fully capability-based** — the legacy name denylist (`LEGACY_NAME_DENY`) was removed. Authorization decisions are entirely driven by declared capabilities.
- ✅ Added `shell.restricted` to `DANGEROUS_FOR_SUBAGENTS` (previously only blocked by name denylist).
- ✅ Updated core high-risk tools with capabilities:
  - `bash` → `shell.arbitrary`
  - `write`, `edit`, `replace`, `patch`, `scaffold` → `fs.write` (+ `fs.write.outside-project` where relevant)
  - `git` → `fs.write` + `shell.restricted`
  - `install` → `package.install` + `shell.restricted`
  - `fetch` → `net.outbound`
  - `read`, `grep`, `glob`, `diff` → `fs.read`
  - `exec` → `shell.restricted`
- ✅ Added comprehensive tests in `permission-policy.test.ts` for capability-based subagent denial + new helper functions.
- ✅ Created reusable helpers: `hasDangerousCapabilityForSubagents`, `hasCapability`, `getDangerousCapabilities`.
- ✅ Integrated helpers into `AutoApprovePermissionPolicy` (removed duplication).
- ✅ Lightly prepared `DefaultPermissionPolicy` path for future capability awareness.
- ✅ Expanded capability declarations to many more tools (tree, search, codebase index tools, etc.).
- Tool content quality pass (Batch A — substantially complete):
  - Comprehensive upgrades to tool self-documentation across nearly all user-facing tools.
  - Strong, consistent emphasis on correct usage, safety, and "how the model should call this tool".

- Invocation guarantees (B — meaningful progress):
  - **Registration-time guarantee**: `ToolRegistry` now rejects tools with missing or invalid `inputSchema` at load time.
  - **Runtime guarantee**: `ToolExecutor` performs full JSON Schema validation on *every* tool call before permission or execution. Bad calls are rejected early with rich, model-actionable error messages (including suggestion to use `tool-help`).
  - Added defense-in-depth observability for dangerous capabilities at the exact moment of invocation.
  - These changes make it much harder for malformed or unauthorized tool calls to succeed.
  - Added much clearer guidance, security warnings, and correct-usage workflows so the model calls tools properly and safely.
- Runtime guarantee improvements:
  - Added capability tracing + dangerous capability detection at the exact point of tool invocation inside `ToolExecutor`.
  - Imported shared capability helpers into the executor for future enforcement points.
- All changes pass typecheck + relevant tests.

**P2 — Process**
- ✅ Strong security comment added to `pnpm-workspace.yaml`.
- ✅ Security checklists + considerations sections added to `tool-author-guide.md` and `plugin-author-guide.md`.

**P3 — Accepted Risks**
- ✅ `SECURITY.md` now has an explicit "Accepted risks & deliberate trade-offs" section referencing the 2026 audits.

**Remaining / Future Work**
- Continue migrating the long tail of tools to declare capabilities (most core tools done).
- Evolve more policies (DefaultPermissionPolicy, plugin mutation rules) to be capability-aware (initial groundwork done).
- Consider adding capability enforcement / visibility in the TUI Fleet / permission prompts.
- Add richer capability documentation and examples to the public tool authoring surface.
- Potential: Surface capabilities in tool help / audit logs.

**2026-06-08 Update:** Legacy name denylist fully removed. `SHELL_RESTRICTED` added to dangerous capabilities. All authorization decisions are now capability-based.

Next review recommended after the next batch of capability migrations or any new high-privilege MCP/tool addition.

**Last updated:** 2026-06 (full implementation pass after security-check rescan)
**Next review:** After additional capability migration or new high-privilege surface addition.
