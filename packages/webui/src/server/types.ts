// Backend types for WebUI server
// These are the internal types used by the server-side code

import type { WebSocket } from 'ws';
import type {
  Agent,
  ConfigStore,
  EventBus,
  ModelsRegistry,
  SecretVault,
  SessionWriter,
  ToolRegistry,
} from '@wrongstack/core';

export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown;
}

export interface WebUIOptions {
  port?: number;
  webuiPort?: number;
}

export interface BackendServices {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  toolRegistry: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  configStore: ConfigStore;
  vault: SecretVault;
  globalConfigPath: string;
  projectRoot: string;
}

export interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
  connectedAt: number;
}
