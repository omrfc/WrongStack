import * as fs from 'node:fs/promises';
import type { Context } from '../core/context.js';
import type { InputReader } from '../types/input-reader.js';
import type { PermissionDecision, PermissionPolicy, TrustPolicy } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { matchAny, matchGlob } from '../utils/glob-match.js';
import { safeParse } from '../utils/safe-json.js';

export interface PermissionPolicyOptions {
  trustFile: string;
  yolo?: boolean;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  inputReader?: InputReader;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  private policy: TrustPolicy = {};
  private loaded = false;
  private readonly trustFile: string;
  private readonly yolo: boolean;
  private readonly promptDelegate?: PermissionPolicyOptions['promptDelegate'];
  /** Pre-compiled wildcard patterns — rebuilt on reload for O(1) lookup. */
  private wildcardEntries: { pattern: string; value: TrustPolicy[string] }[] = [];

  constructor(opts: PermissionPolicyOptions) {
    this.trustFile = opts.trustFile;
    this.yolo = opts.yolo ?? false;
    this.promptDelegate = opts.promptDelegate;
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
    this.loaded = true;
  }

  async evaluate(tool: Tool, input: unknown, _ctx: Context): Promise<PermissionDecision> {
    if (!this.loaded) await this.reload();

    // 1. Tool-namespace matching (mcp__server__* etc.)
    const namespaceEntry = this.findNamespaceEntry(tool.name);

    // 2. Tool-name entry
    const entry = this.policy[tool.name] ?? namespaceEntry;

    // 3. Compute subject (the thing being matched)
    const subject = this.subjectFor(tool.name, input, tool.subjectKey);

    // 4. Deny — absolute
    if (entry?.deny && subject && matchAny(entry.deny, subject)) {
      return { permission: 'deny', source: 'deny', reason: 'matched deny pattern' };
    }
    if (tool.permission === 'deny') {
      return { permission: 'deny', source: 'default', reason: 'tool default deny' };
    }

    // 5. Allow
    if (entry?.allow && subject && matchAny(entry.allow, subject)) {
      return { permission: 'auto', source: 'trust', reason: 'matched allow pattern' };
    }
    if (entry?.auto) {
      return { permission: 'auto', source: 'trust' };
    }

    // 6. YOLO
    if (this.yolo) {
      return { permission: 'auto', source: 'yolo' };
    }

    // 7. Tool default
    if (tool.permission === 'auto') {
      return { permission: 'auto', source: 'default' };
    }

    // 8. Confirm — delegate to prompt
    if (this.promptDelegate) {
      const decision = await this.promptDelegate(tool, input, subject ?? tool.name);
      if (decision === 'always') {
        await this.trust({ tool: tool.name, pattern: subject ?? tool.name });
        return { permission: 'auto', source: 'user', reason: 'user always-allowed' };
      }
      if (decision === 'deny') {
        return { permission: 'deny', source: 'user', reason: 'user denied' };
      }
      return { permission: decision === 'yes' ? 'auto' : 'deny', source: 'user' };
    }
    return { permission: 'confirm', source: 'default' };
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    if (!this.loaded) await this.reload();
    const entry = this.policy[rule.tool] ?? {};
    entry.allow = Array.from(new Set([...(entry.allow ?? []), rule.pattern]));
    this.policy[rule.tool] = entry;
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

  private subjectFor(toolName: string, input: unknown, subjectKey?: string): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;

    // Glob metacharacters are dangerous: a crafted subject like "**" or "foo/**/bar"
    // can match too broadly in the allow/deny pattern match. Escape them so the
    // matching is done on the literal string.
    const globChars = /[*?\[\]]/g;
    const escapeGlob = (s: string) => s.replace(globChars, (c) => `\\${c}`);
    const normalizePath = (s: string) => escapeGlob(s.replace(/\\/g, '/'));

    // 1. Explicit subjectKey on the tool wins — eliminates the cross-tool
    //    collision where e.g. an HTTP tool's `path` field meant "request
    //    path" but was matched against filesystem-path trust rules.
    if (subjectKey) {
      const v = obj[subjectKey];
      if (typeof v === 'string') {
        // Heuristic: path-like keys get backslash normalization for glob
        // matching on Windows; everything else is treated as opaque.
        return subjectKey === 'path' || subjectKey === 'file' || subjectKey === 'files'
          ? normalizePath(v)
          : escapeGlob(v);
      }
      // subjectKey was declared but the runtime value isn't a string —
      // fall through to the legacy heuristic so the policy still has a
      // chance to match on something sensible.
    }

    // 2. Legacy heuristic — preserved for tools that haven't migrated.
    if (toolName === 'bash' && typeof obj.command === 'string') {
      return escapeGlob(obj.command);
    }
    if (typeof obj.path === 'string') {
      return normalizePath(obj.path);
    }
    if (typeof obj.url === 'string') {
      return escapeGlob(obj.url);
    }
    if (typeof obj.name === 'string') {
      return escapeGlob(obj.name);
    }
    return undefined;
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
 */
export class AutoApprovePermissionPolicy implements PermissionPolicy {
  async evaluate(tool: Tool): Promise<PermissionDecision> {
    if (tool.permission === 'deny') {
      return { permission: 'deny', source: 'default', reason: 'tool default deny' };
    }
    return { permission: 'auto', source: 'yolo' };
  }
  async trust(): Promise<void> {
    // No-op: subagent permission decisions are ephemeral and must not
    // pollute the leader's persisted trust file.
  }
  async reload(): Promise<void> {
    // No-op: nothing to load.
  }
}
