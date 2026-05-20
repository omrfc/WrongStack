import type { Context } from '../core/context.js';
import type { Permission, Tool } from './tool.js';

export interface TrustPolicy {
  [toolNameOrPattern: string]: {
    allow?: string[];
    deny?: string[];
    auto?: boolean;
    trustWorkdir?: boolean;
    denyPrivate?: boolean;
  };
}

export interface PermissionDecision {
  permission: Permission;
  reason?: string;
  source: 'default' | 'trust' | 'yolo' | 'yolo_destructive' | 'user' | 'deny' | 'context';
  /** Risk tier of the tool, if classified. */
  riskTier?: 'safe' | 'standard' | 'destructive';
}

export interface PermissionPolicy {
  evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision>;
  trust(rule: { tool: string; pattern: string }): Promise<void>;
  /**
   * Persist a permanent deny rule (mirrors trust). Written to trust.json.
   */
  deny(rule: { tool: string; pattern: string }): Promise<void>;
  /**
   * Block this tool+pattern for the remainder of the session (no persistence).
   * Used when user presses 'n' — prevents LLM retry from re-triggering confirm.
   */
  denyOnce(rule: { tool: string; pattern: string }): void;
  /**
   * Auto-approve this tool+pattern for the remainder of the session (no persistence).
   * Used when user presses 'y' — prevents LLM retry from re-triggering confirm.
   */
  allowOnce(rule: { tool: string; pattern: string }): void;
  reload(): Promise<void>;
}
