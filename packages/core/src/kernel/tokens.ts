import type { Compactor } from '../types/compactor.js';
import type { ConfigLoader, ConfigStore } from '../types/config.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { InputReader } from '../types/input-reader.js';
import type { Logger } from '../types/logger.js';
import type { MemoryStore } from '../types/memory.js';
import type { ModeStore } from '../types/mode.js';
import type { ModelsRegistry } from '../types/models-registry.js';
import type { PathResolver } from '../types/path-resolver.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { ProviderRunner } from '../types/provider-runner.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { SessionStore } from '../types/session.js';
import type { SkillLoader } from '../types/skill.js';
import type { SystemPromptBuilder } from '../types/system-prompt.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { Token } from './container.js';

const t = <T>(name: string): Token<T> => Symbol(name) as Token<T>;

export const TOKENS = {
  Logger: t<Logger>('Logger'),
  TokenCounter: t<TokenCounter>('TokenCounter'),
  SessionStore: t<SessionStore>('SessionStore'),
  MemoryStore: t<MemoryStore>('MemoryStore'),
  PermissionPolicy: t<PermissionPolicy>('PermissionPolicy'),
  Compactor: t<Compactor>('Compactor'),
  PathResolver: t<PathResolver>('PathResolver'),
  ConfigLoader: t<ConfigLoader>('ConfigLoader'),
  ConfigStore: t<ConfigStore>('ConfigStore'),
  Renderer: t<Renderer>('Renderer'),
  InputReader: t<InputReader>('InputReader'),
  ErrorHandler: t<ErrorHandler>('ErrorHandler'),
  RetryPolicy: t<RetryPolicy>('RetryPolicy'),
  SkillLoader: t<SkillLoader>('SkillLoader'),
  SystemPromptBuilder: t<SystemPromptBuilder>('SystemPromptBuilder'),
  SecretScrubber: t<SecretScrubber>('SecretScrubber'),
  ModelsRegistry: t<ModelsRegistry>('ModelsRegistry'),
  ModeStore: t<ModeStore>('ModeStore'),
  /** Replaces the entire provider call layer — retry, streaming, tracing. */
  ProviderRunner: t<ProviderRunner>('ProviderRunner'),
  /** Optional git-worktree lifecycle manager (per-phase isolation in AutoPhase). */
  WorktreeManager: t<WorktreeManager>('WorktreeManager'),
} as const;
