export type BridgeMessageType =
  | 'task'
  | 'result'
  | 'progress'
  | 'error'
  | 'heartbeat'
  | 'stop'
  | 'delegate';

export interface BridgeMessage<T = unknown> {
  id: string;
  type: BridgeMessageType;
  from: string;
  to?: string;
  payload: T;
  timestamp: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
}

export interface AgentBridgeConfig {
  agentId: string;
  coordinatorId: string;
  timeoutMs?: number;
  bufferSize?: number;
}

export interface AgentBridge {
  readonly agentId: string;
  readonly coordinatorId: string;

  send(msg: BridgeMessage): Promise<void>;
  broadcast(msg: BridgeMessage): Promise<void>;
  subscribe(handler: (msg: BridgeMessage) => void | Promise<void>): () => void;
  request<T>(msg: BridgeMessage, timeoutMs?: number): Promise<BridgeMessage<T>>;
  stop(): Promise<void>;
}

export interface BridgeTransport {
  send(msg: BridgeMessage, to: string): Promise<void>;
  subscribe(agentId: string, handler: (msg: BridgeMessage) => void | Promise<void>): () => void;
  close(agentId: string): Promise<void>;
}
