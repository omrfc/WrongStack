/**
 * Official ACP TypeScript SDK integration for WrongStack.
 *
 * This module re-exports types and utilities from @agentclientprotocol/sdk
 * alongside WrongStack's own ACP implementation, providing 100% ACP v1
 * type coverage.
 *
 * Import from here when you need the full ACP type surface:
 *   import { ACPSession, AcpServer, schema, ... } from '@wrongstack/acp/sdk';
 */

// Re-export the SDK's method constants (never conflict)
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

// Re-export the SDK's high-level API
export {
  AgentApp,
  ClientApp,
  ActiveSession,
  SessionBuilder,
  methods,
} from '@agentclientprotocol/sdk';
export type {
  AgentContext,
  AgentConnection,
  ClientContext,
  ClientConnection,
  AcpConnection,
} from '@agentclientprotocol/sdk';

// Re-export server and transports
export {
  AcpServer,
} from '@agentclientprotocol/sdk/experimental/server';

export {
  createWebSocketStream,
} from '@agentclientprotocol/sdk/experimental/ws-client';

export type {
  WebSocketStreamOptions,
} from '@agentclientprotocol/sdk/experimental/ws-client';

export {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from '@agentclientprotocol/sdk/experimental/node';

// The official ACP JSON schema — import as JSON for type validation
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type schema from '@agentclientprotocol/sdk/schema/schema.json';
export type { schema };

// Re-export WrongStack's ACP implementation
export {
  ACPSession,
  ACPSessionError,
  textContent,
  imageContent,
  audioContent,
} from './client/acp-session.js';
export type {
  ACPSessionOptions,
  ACPSessionRunResult,
  ACPSessionErrorKind,
  ACPProgressEvent,
  ACPProgressHandler,
  ACPCapturedToolCall,
  ACPCapturedDiff,
} from './client/acp-session.js';

export { WebSocketClientTransport } from './client/websocket-transport.js';
export type { WebSocketClientTransportOptions } from './client/websocket-transport.js';
export type { ACPClientTransport } from './agent/stdio-transport.js';

export {
  ACPProtocolHandler,
  WRONGSTACK_VERSION,
} from './agent/protocol-handler.js';
export type {
  RunTurn,
  RunTurnResult,
  RunTurnInput,
  SessionState,
  SessionMode,
  SessionConfigOption,
  ProtocolHandlerOptions,
} from './agent/protocol-handler.js';

export {
  WrongStackACPServer,
} from './agent/wrongstack-acp-agent.js';
export type {
  WrongStackACPServerOptions,
} from './agent/wrongstack-acp-agent.js';

export {
  makeACPServerAgentTurn,
  disposeACPServerAgentTurn,
} from './agent/server-agent-turn.js';
export type {
  ACPServerAgentTurnOptions,
} from './agent/server-agent-turn.js';

export {
  ACPSessionStore,
} from './agent/session-store.js';
export type {
  SessionStoreOptions,
} from './agent/session-store.js';

export {
  FileServer,
  FsError,
} from './client/file-server.js';
export type {
  FileServerOptions,
  ReadFileParams,
  WriteFileParams,
  FsErrorCode,
} from './client/file-server.js';

export {
  TerminalServer,
} from './client/terminal-server.js';
export type {
  TerminalServerOptions,
} from './client/terminal-server.js';

export {
  defaultPermissionPolicy,
  readOnlyPermissionPolicy,
  makePermissionPolicy,
} from './client/permission.js';
export type {
  PermissionPolicy,
  PermissionRequest,
} from './client/permission.js';

export {
  makeACPSubagentRunner,
  makeACPSubagentRunnerWithStop,
  ACP_AGENT_COMMANDS,
} from './integration/acp-subagent-runner.js';
export type {
  ACPSubagentRunnerOptions,
} from './integration/acp-subagent-runner.js';
