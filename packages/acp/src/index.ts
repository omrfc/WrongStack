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
export type {ClientTransportOptions, ACPChildProcess} from './agent/stdio-transport.js';
export {ToolTranslator} from './client/tool-translator.js';
export type {ToolTranslatorOptions} from './client/tool-translator.js';
export {makeACPSubagentRunner, makeACPSubagentRunnerWithStop} from './integration/acp-subagent-runner.js';
export type {ACPSubagentRunnerOptions} from './integration/acp-subagent-runner.js';
export {ACP_AGENT_COMMANDS} from './integration/acp-subagent-runner.js';

// Types
export * from './types/acp-messages.js';
