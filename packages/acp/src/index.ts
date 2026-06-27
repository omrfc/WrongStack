/**
 * @wrongstack/acp — ACP integration public surface.
 *
 * DIR-2: WrongStack as ACP Server
 *   import { WrongStackACPServer } from '@wrongstack/acp/agent';
 *
 * DIR-1: WrongStack as ACP Client
 *   import { makeACPSubagentRunner } from '@wrongstack/acp/client';
 */

// Agent (server) side
export {StdioTransport} from './agent/stdio-transport.js';
export type {AgentServerTransport} from './agent/stdio-transport.js';
export {ACPToolsRegistry} from './agent/tools-registry.js';
export {ACPProtocolHandler} from './agent/protocol-handler.js';
export {WrongStackACPServer} from './agent/wrongstack-acp-agent.js';
export type {WrongStackACPServerOptions} from './agent/wrongstack-acp-agent.js';

// Client side (DIR-1: WrongStack spawns external ACP agents)
export {ClientTransport} from './agent/stdio-transport.js';
export type {ClientTransportOptions, ACPChildProcess, ACPClientTransport} from './agent/stdio-transport.js';
export {WebSocketClientTransport} from './client/websocket-transport.js';
export type {WebSocketClientTransportOptions} from './client/websocket-transport.js';
export {ToolTranslator} from './client/tool-translator.js';
export type {ToolTranslatorOptions} from './client/tool-translator.js';
export {makeACPSubagentRunner, makeACPSubagentRunnerWithStop} from './integration/acp-subagent-runner.js';
export type {ACPSubagentRunnerOptions} from './integration/acp-subagent-runner.js';
export {ACP_AGENT_COMMANDS} from './integration/acp-subagent-runner.js';

// Discovery — the catalog + registry (added in feat/acp-ensemble).
export {AGENTS_CATALOG, findAgentDescriptor} from './registry/agents.catalog.js';
export {EnsembleRegistry} from './registry/ensemble-registry.js';
export type {
  ACPAgentDescriptor,
  ACPAgentVendor,
  ACPIntegration,
  DetectedAgent,
  EnsembleRegistryOptions,
} from './registry/ensemble-registry.js';

// Client session — the v1-correct ACP client (added in feat/acp-ensemble).
export {ACPSession, ACPSessionError, textContent, imageContent, audioContent} from './client/acp-session.js';
export type {
  ACPSessionOptions,
  ACPSessionRunResult,
  ACPSessionErrorKind,
  ACPProgressEvent,
  ACPProgressHandler,
  ACPCapturedToolCall,
  ACPCapturedDiff,
} from './client/acp-session.js';
export {FileServer, FsError} from './client/file-server.js';
export type {FileServerOptions, ReadFileParams, WriteFileParams, FsErrorCode} from './client/file-server.js';
export {TerminalServer} from './client/terminal-server.js';
export type {TerminalServerOptions} from './client/terminal-server.js';
export {
  defaultPermissionPolicy,
  readOnlyPermissionPolicy,
  makePermissionPolicy,
} from './client/permission.js';
export type {PermissionPolicy, PermissionRequest} from './client/permission.js';

// Ensemble runner — fan a single task out to multiple ACP agents.
export {
  defaultEnsembleCmdResolver,
  renderEnsembleText,
  runEnsemble,
  type EnsembleAgentResult,
  type EnsembleCmdResolver,
  type EnsembleProgressHandler,
  type EnsembleResult,
  type EnsembleRunnerOptions,
} from './integration/ensemble-runner.js';

// Types
export * from './types/acp-messages.js';
