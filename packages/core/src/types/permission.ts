import type { Context } from '../core/context.js';
import type { Permission, Tool } from './tool.js';

export interface TrustPolicy {
  [toolNameOrPattern: string]: {
    allow?: string[] | undefined;
    deny?: string[] | undefined;
    auto?: boolean | undefined;
    trustWorkdir?: boolean | undefined;
    denyPrivate?: boolean | undefined;
  };
}

export interface PermissionDecision {
  permission: Permission;
  reason?: string | undefined;
  source: 'default' | 'trust' | 'yolo' | 'yolo_destructive' | 'user' | 'deny' | 'context' | 'subagent_guard';
  /** Risk tier of the tool, if classified. */
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
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
   * Auto-approve this tool+pattern once (no persistence). Used when user
   * presses 'y' so the immediate confirmed re-run can proceed without making
   * future destructive calls silent.
   */
  allowOnce(rule: { tool: string; pattern: string }): void;
  reload(): Promise<void>;
  /** Optional runtime query for policies that support leader YOLO toggling. */
  getYolo?(): boolean;
  /** Optional runtime setter for policies that support leader YOLO toggling. */
  setYolo?(enabled: boolean): void;
  /** Optional runtime query for the deprecated destructive YOLO override. */
  getYoloDestructive?(): boolean;
  /** Optional runtime setter for the deprecated destructive YOLO override. */
  setYoloDestructive?(enabled: boolean): void;
  /** Query whether destructive-operation confirmation gate is active. */
  getConfirmDestructive?(): boolean;
  /** Compatibility setter; current default policy keeps the gate enabled in YOLO mode. */
  setConfirmDestructive?(enabled: boolean): void;
  /** Set the prompt delegate (optional). */
  setPromptDelegate?(delegate: ((tool: Tool, input: unknown, suggestedPattern: string) => Promise<'yes' | 'no' | 'always' | 'deny'>) | undefined): void;
}
