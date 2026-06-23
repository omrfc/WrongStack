import * as fs from 'node:fs/promises';
import type { Context } from '../core/context.js';
import type { InputReader } from '../types/input-reader.js';
import type { PermissionDecision, PermissionPolicy, TrustPolicy } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { getDangerousCapabilities, hasCapability, ToolCapabilities } from './capabilities.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { matchAny, matchGlob } from '../utils/glob-match.js';
import { safeParse } from '../utils/safe-json.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import {
  getInputString,
  isClearlyDestructiveBashCommand,
  pathLooksInsideProject,
} from './yolo-risk.js';

/**
 * Match a computed subject against stored trust patterns.
 *
 * Exact string equality is checked FIRST, before glob compilation. Subjects are
 * glob-escaped at the source (`escapeGlobSubject` turns `* ? [ ]` into `\* \? \[
 * \]`), and a stored "always"-trust pattern is just a prior subject — so for an
 * identical command the pattern and the subject are byte-for-byte equal. The
 * glob matcher alone could not confirm that: `compileGlob` does not treat a
 * backslash as an escape outside character classes, so an escaped `\[`/`\]` is
 * parsed as a character-class delimiter and a command like `[ -f x ]` or
 * `grep "[0-9]"` never re-matched its own trust entry — re-prompting forever
 * even after the user chose "always" (#15). Exact equality is also strictly
 * tighter than a glob, so this never widens what a pattern authorizes; genuine
 * wildcard patterns (e.g. a user-authored `git *`) still fall through to glob.
 */
function matchesTrust(patterns: string[], subject: string): boolean {
  return patterns.includes(subject) || matchAny(patterns, subject);
}

export interface PermissionPolicyOptions {
  trustFile: string;
  yolo?: boolean | undefined;
  /**
   * When true, YOLO mode auto-approves even destructive calls without confirm.
   * @deprecated YOLO now auto-approves everything by default. Use `confirmDestructive`
   *   to opt back into destructive-operation confirmation prompts.
   */
  yoloDestructive?: boolean | undefined;
  /** @deprecated Use `yoloDestructive`. */
  forceAllYolo?: boolean | undefined;
  /**
   * When true AND yolo is true, destructive operations still require confirmation.
   * This is the opt-in safety net: set this if you want YOLO for normal work but
   * explicit approval for `rm -rf`, project-escaping writes, etc.
   * Has no effect when yolo is false (normal permission flow applies).
   */
  confirmDestructive?: boolean | undefined;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  inputReader?: InputReader | undefined;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  private policy: TrustPolicy = {};
  private loaded = false;
  private readonly trustFile: string;
  private yolo: boolean;
  private yoloDestructive: boolean;
  /** When true, destructive ops still require confirmation even in YOLO mode. */
  private confirmDestructive: boolean;
  /**
   * Session-scoped "soft deny" map. When the user presses 'n' (block once),
   * the tool+pattern is added here. If the LLM retries in the same session,
   * we return deny directly without asking again.
   *
   * Cleared on reload() since reload = fresh trust file snapshot.
   */
  private sessionDenied = new Map<string, boolean>();
  /**
   * Session-scoped "soft trust" map. When the user presses 'a' (allow once),
   * the tool+pattern is added here. If the LLM retries in the same session,
   * we return auto directly without asking again.
   *
   * Cleared on reload().
   */
  private sessionAllowed = new Map<string, boolean>();
  /**
   * Interactive prompt delegate. When set, `evaluate()` calls it to get a
   * user decision synchronously (CLI REPL path). When cleared (TUI / WebUI),
   * `evaluate()` returns `confirm` so the caller can emit
   * `tool.confirm_needed` for the UI layer to handle.
   *
   * Mutable so the host can switch from CLI-prompt to event-driven
   * confirmation at runtime (e.g. when `--goal` forces TUI mode after
   * the agent was already constructed).
   */
  private promptDelegate?: PermissionPolicyOptions['promptDelegate'] | undefined;
  /** Pre-compiled wildcard patterns — rebuilt on reload for O(1) lookup. */
  private wildcardEntries: { pattern: string; value: TrustPolicy[string] }[] = [];
  /**
   * Evaluate-result cache. Keyed by `tool.name::subject` so repeated calls
   * with the same tool+input skip namespace matching, subject computation,
   * pattern matching (matchAny), and YOLO destructive gating.
   *
   * Cleared on any state change (reload, trust, deny, yolo toggle) because
   * the result depends on the full policy state. The write-tool smart-bypass
   * (step 7 in `evaluate()`) is not cached since `ctx.hasRead()` changes
   * dynamically within a session.
   *
   * LRU eviction is not needed — the cache is cleared on state changes
   * that are rare (trust file ops, user confirm) and the number of unique
   * tool+subject pairs per iteration is small (<50).
   */
  private _evalCache = new Map<string, PermissionDecision>();

  constructor(opts: PermissionPolicyOptions) {
    this.trustFile = opts.trustFile;
    this.yolo = opts.yolo ?? false;
    this.yoloDestructive = opts.yoloDestructive ?? opts.forceAllYolo ?? false;
    this.confirmDestructive = opts.confirmDestructive ?? false;
    this.promptDelegate = opts.promptDelegate;
  }

  /**
   * Replace (or clear) the interactive prompt delegate at runtime.
   * Used by the CLI to switch from inline prompts (REPL) to event-driven
   * confirmation (TUI) when the run mode is determined after the policy
   * was constructed (e.g. `--goal` auto-flipping to TUI).
   */
  setPromptDelegate(delegate: PermissionPolicyOptions['promptDelegate']): void {
    this.promptDelegate = delegate;
  }

  /** Toggle YOLO (auto-approve) mode at runtime. */
  setYolo(enabled: boolean): void {
    if (this.yolo !== enabled) this._evalCache.clear();
    this.yolo = enabled;
  }

  /** Check whether YOLO mode is currently active. */
  getYolo(): boolean {
    return this.yolo;
  }

  /** Toggle the destructive YOLO override at runtime. */
  setYoloDestructive(enabled: boolean): void {
    if (this.yoloDestructive !== enabled) this._evalCache.clear();
    this.yoloDestructive = enabled;
  }

  /** Check whether the destructive YOLO override is active. */
  getYoloDestructive(): boolean {
    return this.yoloDestructive;
  }

  /** Toggle destructive confirmation gate (only meaningful when yolo is active). */
  setConfirmDestructive(enabled: boolean): void {
    if (this.confirmDestructive !== enabled) this._evalCache.clear();
    this.confirmDestructive = enabled;
  }

  /** Check whether destructive confirmation gate is active. */
  getConfirmDestructive(): boolean {
    return this.confirmDestructive;
  }

  async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.trustFile, 'utf8');
      const parsed = safeParse<TrustPolicy>(raw);
      if (parsed.ok && parsed.value) this.policy = parsed.value;
    } catch {
      this.policy = {};
    }
    // Pre-compile wildcard entries so findNamespaceEntry is O(k) instead of O(n*m)
    this.wildcardEntries = [];
    for (const [key, val] of Object.entries(this.policy)) {
      if (key.includes('*')) this.wildcardEntries.push({ pattern: key, value: val });
    }
    // Clear session-scoped soft deny/allow — reload = fresh trust file snapshot
    this.sessionDenied.clear();
    this.sessionAllowed.clear();
    this._evalCache.clear();
    this.loaded = true;
  }

  async evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision> {
    if (!this.loaded) await this.reload();

    // 1. Tool-namespace matching (mcp__server__* etc.)
    const namespaceEntry = this.findNamespaceEntry(tool.name);

    // 2. Tool-name entry
    const entry = this.policy[tool.name] ?? namespaceEntry;

    // 3. Compute subject (the thing being matched)
    const subject = subjectForToolInput(tool.name, input, tool.subjectKey);
    const cacheKey = `${tool.name}::${subject ?? tool.name}`;

    // S1. Cache check — skip namespace/subject/pattern re-evaluation when the
    //     same tool+subject was already decided. The write-tool smart bypass
    //     (step 7) is NOT cached because `ctx.hasRead()` changes dynamically
    //     within a session — we let it fall through below.
    if (tool.name !== 'write') {
      const cached = this._evalCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    // 3a. Session soft deny — 'n' blocks this tool+pattern for the rest of
    //     this session without writing to the trust file. Prevents LLM retry
    //     from re-triggering the confirm prompt.
    if (this.sessionDenied.has(cacheKey)) {
      const decision: PermissionDecision = { permission: 'deny', source: 'deny', reason: 'session soft deny (user pressed no)' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 3b. Session soft allow — 'y' auto-approves this tool+pattern for the
    //     rest of this session without writing to the trust file.
    if (this.sessionAllowed.has(cacheKey)) {
      const decision: PermissionDecision = {
        permission: 'auto',
        source: 'trust',
        reason: 'session soft allow (user pressed yes)',
      };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 4. Deny — absolute
    if (entry?.deny && subject && matchesTrust(entry.deny, subject)) {
      const decision: PermissionDecision = { permission: 'deny', source: 'deny', reason: 'matched deny pattern' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }
    if (tool.permission === 'deny') {
      const decision: PermissionDecision = { permission: 'deny', source: 'default', reason: 'tool default deny' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 5. Allow (trust file)
    if (entry?.allow && subject && matchesTrust(entry.allow, subject)) {
      const decision: PermissionDecision = { permission: 'auto', source: 'trust', reason: 'matched allow pattern' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }
    if (entry?.auto) {
      const decision: PermissionDecision = { permission: 'auto', source: 'trust' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 6. YOLO — auto-approve everything. Destructive operations are
    // included unless the user explicitly opted into `confirmDestructive`.
    if (this.yolo) {
      if (this.confirmDestructive) {
        const destructive = this.isDestructiveYoloCall(tool, input, ctx);
        if (destructive) {
          if (this.promptDelegate) {
            const decision = await this.promptDelegate(tool, input, subject ?? tool.name);
            if (decision === 'always') {
              await this.trust({ tool: tool.name, pattern: subject ?? tool.name });
              return { permission: 'auto', source: 'user', reason: 'destructive yolo always-allowed' };
            }
            if (decision === 'deny') {
              await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
              return { permission: 'deny', source: 'user', reason: 'user denied destructive yolo' };
            }
            return { permission: decision === 'yes' ? 'auto' : 'deny', source: 'user' };
          }
          return {
            permission: 'confirm',
            source: 'yolo_destructive',
            riskTier: 'destructive',
            reason: 'destructive tool needs explicit approval (confirmDestructive is on)',
          };
        }
      }
      const decision: PermissionDecision = { permission: 'auto', source: 'yolo' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 7. Smart bypass: write tool — if the file was already read in this
    // session, the user has already seen the content. No confirm needed.
    // NOTE: deliberately NOT cached because ctx.hasRead() changes dynamically.
    if (tool.name === 'write' && subject) {
      if (ctx.hasRead(subject)) {
        return {
          permission: 'auto',
          source: 'context',
          reason: 'file already read in this session',
        };
      }
    }

    // 8. Tool default — but mutating tools need confirmation even with
    // auto-permission (e.g. shellcheck makes network calls; a remote WebSocket
    // client must not be able to trigger them without the user seeing the
    // tool.confirm_needed prompt). Non-mutating auto tools (read-only
    // heuristics, schema checks) are still safe to shortcut.
    //
    // Capability-based check: tools with fs.read or net.outbound (non-mutating)
    // can auto-approve; tools with fs.write, shell.*, etc. need confirmation.
    const hasWriteCap = hasCapability(tool, ToolCapabilities.FS_WRITE);
    const hasShellCap = hasCapability(tool, [
      ToolCapabilities.SHELL_ARBITRARY,
      ToolCapabilities.SHELL_RESTRICTED,
    ]);
    const hasInstallCap = hasCapability(tool, ToolCapabilities.PACKAGE_INSTALL);
    const hasConfigCap = hasCapability(tool, ToolCapabilities.CONFIG_MUTATE);
    const hasSubagentCap = hasCapability(tool, ToolCapabilities.SUBAGENT_SPAWN);
    const isMutating = tool.mutating || hasWriteCap || hasShellCap || hasInstallCap || hasConfigCap || hasSubagentCap;
    if (tool.permission === 'auto' && !isMutating) {
      const decision: PermissionDecision = { permission: 'auto', source: 'default' };
      this._evalCache.set(cacheKey, decision);
      return decision;
    }

    // 9. Confirm — delegate to prompt
    if (this.promptDelegate) {
      const decision = await this.promptDelegate(tool, input, subject ?? tool.name);
      if (decision === 'always') {
        await this.trust({ tool: tool.name, pattern: subject ?? tool.name });
        return { permission: 'auto', source: 'user', reason: 'user always-allowed' };
      }
      if (decision === 'deny') {
        await this.deny({ tool: tool.name, pattern: subject ?? tool.name });
        return { permission: 'deny', source: 'user', reason: 'user denied' };
      }
      return { permission: decision === 'yes' ? 'auto' : 'deny', source: 'user' };
    }
    return { permission: 'confirm', source: 'default' };
  }

  // Capability-based destructive check (preferred over name-based)
  private isDestructiveByCapability(tool: Tool): boolean {
    const caps = tool.capabilities ?? [];
    if (caps.includes('shell.arbitrary')) return true;
    if (caps.includes('fs.write')) return true;
    if (caps.includes('fs.write.outside-project')) return true;
    return false;
  }

  private isDestructiveYoloCall(tool: Tool, input: unknown, ctx: Context): boolean {
    // 1. Capability-based check (preferred — works for all tools, not just hardcoded names)
    if (this.isDestructiveByCapability(tool)) {
      // For shell tools, also check if the command is clearly destructive
      if (tool.name === 'bash') {
        const command = getInputString(input, 'command');
        return command ? isClearlyDestructiveBashCommand(command, ctx.projectRoot) : true;
      }
      // For write tools, check if path escapes project
      if (tool.name === 'write' || tool.name === 'edit' || tool.name === 'replace' || tool.name === 'patch') {
        const targetPath = getInputString(input, 'path') ?? getInputString(input, 'file');
        if (!targetPath || !ctx.projectRoot) return false;
        return !pathLooksInsideProject(targetPath, ctx.projectRoot);
      }
      return true;
    }

    // 2. Legacy name-based fallback (for tools without capabilities)
    if (tool.name === 'bash') {
      const command = getInputString(input, 'command');
      return command ? isClearlyDestructiveBashCommand(command, ctx.projectRoot) : true;
    }

    if (tool.name === 'write' || tool.name === 'edit' || tool.name === 'replace' || tool.name === 'patch') {
      const targetPath = getInputString(input, 'path') ?? getInputString(input, 'file');
      if (!targetPath || !ctx.projectRoot) return false;
      return !pathLooksInsideProject(targetPath, ctx.projectRoot);
    }

    return tool.riskTier === 'destructive';
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    const entry = this.policy[rule.tool] ?? {};
    entry.allow = Array.from(new Set([...(entry.allow ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      // Revert in-memory state since disk write failed
      const existing = this.policy[rule.tool];
      if (existing?.allow) {
        const idx = existing.allow.indexOf(rule.pattern);
        if (idx !== -1) existing.allow.splice(idx, 1);
      }
      throw err;
    }
  }

  /** Persist a deny rule — this tool+pattern pair is permanently blocked. */
  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    const entry = this.policy[rule.tool] ?? {};
    entry.deny = Array.from(new Set([...(entry.deny ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
    this._evalCache.clear();
    try {
      await atomicWrite(this.trustFile, JSON.stringify(this.policy, null, 2));
    } catch (err) {
      // Revert in-memory state since disk write failed
      const existing = this.policy[rule.tool];
      if (existing?.deny) {
        const idx = existing.deny.indexOf(rule.pattern);
        if (idx !== -1) existing.deny.splice(idx, 1);
      }
      throw err;
    }
  }

  /** Block this tool+pattern for the rest of this session (no trust file). */
  denyOnce(rule: { tool: string; pattern: string }): void {
    this.sessionDenied.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }

  /** Auto-approve this tool+pattern for the rest of this session (no trust file). */
  allowOnce(rule: { tool: string; pattern: string }): void {
    this.sessionAllowed.set(`${rule.tool}::${rule.pattern}`, true);
    this._evalCache.clear();
  }


  private findNamespaceEntry(toolName: string): TrustPolicy[string] | undefined {
    // Use pre-compiled wildcard entries — O(k) where k = wildcard count
    for (const { pattern, value } of this.wildcardEntries) {
      if (matchGlob(pattern, toolName)) return value;
    }
    return undefined;
  }
}

/**
 * Auto-approving PermissionPolicy used for subagents. Subagents run
 * non-interactively under a director — they cannot answer permission
 * prompts, so a non-YOLO policy on the leader would silently hang the
 * delegated run on the first sensitive tool call. The user already
 * authorized the delegation when they invoked the leader; subagents
 * inherit that authorization automatically.
 *
 * Tool defaults of `permission: 'deny'` are still honored (this is a
 * subagent capability override, not a deny-bypass).
 *
 * 2026-06+: Primary decision is now based on declared `Tool.capabilities`
 * (capability allowlist / denylist model). The legacy name-based DENY set
 * is kept only for backward compatibility with tools that have not yet
 * declared capabilities.
 */
/**
 * Auto-approving PermissionPolicy used for subagents. Subagents run
 * non-interactively under a director — they cannot answer permission
 * prompts, so a non-YOLO policy on the leader would silently hang the
 * delegated run on the first sensitive tool call. The user already
 * authorized the delegation when they invoked the leader; subagents
 * inherit that authorization automatically.
 *
 * Tool defaults of `permission: 'deny'` are still honored (this is a
 * subagent capability override, not a deny-bypass).
 *
 * 2026-06+: Primary decision is now based on declared `Tool.capabilities`
 * (capability allowlist / denylist model). The legacy name-based DENY set
 * is kept only for backward compatibility with tools that have not yet
 * declared capabilities.
 *
 * 2026-06-13+: Switched to allowlist-by-default. Only tools with explicitly
 * allowed capabilities are auto-approved. Everything else is denied.
 * Default allowed: fs.read, net.outbound (read-only, safe operations).
 */
export class AutoApprovePermissionPolicy implements PermissionPolicy {
  private readonly allowedCapabilities: readonly string[];

  constructor(allowedCapabilities?: readonly string[]) {
    // Default allowlist: read-only, safe operations
    this.allowedCapabilities = allowedCapabilities ?? [
      ToolCapabilities.FS_READ,
      ToolCapabilities.NET_OUTBOUND,
    ];
  }

  private static isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  async evaluate(tool: Tool): Promise<PermissionDecision> {
    const caps = tool.capabilities ?? [];
    const hasAllowedCap = caps.some((c) => this.allowedCapabilities.includes(c));
    const isMcp = AutoApprovePermissionPolicy.isMcpTool(tool.name);
    const mcpProxyAllowed = this.allowedCapabilities.includes(ToolCapabilities.MCP_PROXY);

    // A tool may bundle several capabilities (e.g. `install` declares both
    // `package.install` and `shell.restricted`). The `some()` check above only
    // confirms the tool has *a* useful allowed capability — it does not stop a
    // dangerous capability from riding along. Require every DANGEROUS capability
    // the tool declares to be explicitly present in the allowlist, so widening
    // the allowlist (e.g. `/techstack` adding `fs.write`) grants exactly that
    // capability and nothing more. This is what lets the ToolExecutor trust an
    // `auto` from this policy and skip its post-permission dangerous-capability
    // downgrade (which would otherwise force a `confirm` no subagent can answer).
    const dangerousNotAllowed = getDangerousCapabilities(tool).filter(
      (c) => !this.allowedCapabilities.includes(c),
    );

    // Block if: tool is an MCP proxy without an explicit mcp.proxy grant,
    // tool default is deny, no allowed capability, or it carries a dangerous
    // capability the leader did not explicitly grant.
    const blocked =
      tool.permission === 'deny' ||
      (isMcp && !mcpProxyAllowed) ||
      !hasAllowedCap ||
      dangerousNotAllowed.length > 0;

    if (blocked) {
      const reason = isMcp && !mcpProxyAllowed
        ? `MCP tool ${tool.name} is not auto-approved for subagents — ask the leader to allow mcp.proxy explicitly`
        : tool.permission === 'deny'
          ? 'tool default deny'
          : dangerousNotAllowed.length > 0
            ? `tool requires un-granted dangerous capability (needs: ${dangerousNotAllowed.join(', ')}, allowed: ${this.allowedCapabilities.join(', ')})`
            : `tool lacks allowed capability (has: ${caps.join(', ') || 'none'}, allowed: ${this.allowedCapabilities.join(', ')})`;

      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason,
      };
    }

    return { permission: 'auto', source: 'yolo' };
  }
  async trust(): Promise<void> {
    // No-op: subagent permission decisions are ephemeral and must not
    // pollute the leader's persisted trust file.
  }
  async deny(): Promise<void> {
    // No-op: same as trust — subagent decisions are ephemeral.
  }
  denyOnce(): void {
    // No-op: subagent decisions are ephemeral.
  }
  allowOnce(): void {
    // No-op: subagent decisions are ephemeral.
  }
  async reload(): Promise<void> {
    // No-op: nothing to load.
  }
}
