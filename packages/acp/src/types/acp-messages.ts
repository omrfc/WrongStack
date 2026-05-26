/**
 * ACP message types — transport-agnostic JSON-RPC 2.0 envelope.
 * Reuses MCP types where possible; custom types for agentic UX (diffs, plans).
 */
export interface ACPMessage {
  method: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: ACPError;
}

export interface ACPError {
  code: number;
  message: string;
  data?: unknown;
}

export type ACPRequest = RequiredPick<ACPMessage, 'id' | 'params' | 'method'>;
export type ACPResponse = RequiredPick<ACPMessage, 'id' | 'result' | 'method'>;
export type ACPNotification = Omit<ACPMessage, 'id'> & { method: string };

// --- Initialization ---
export interface ACPInitializeParams {
  capabilities?: string[];
  protocolVersion?: string;
  sessionId?: string;
  authToken?: string;
  sessionPath?: string;
  workspaceRoots?: string[];
  mcpServers?: unknown[];
  [key: string]: unknown;
}

export interface ACPCapabilities {
  capabilities: string[];
  agentName: string;
  agentVersion: string;
  tools?: ACPToolList;
  protocolVersion: string;
}

export interface ACPToolList {
  tools: ACPToolDefinition[];
}

// --- Tools ---
export interface ACPToolDefinition {
  name: string;
  description?: string;
  inputSchema: ACPInputSchema;
  annotations?: {
    title?: string;
    description?: string;
    priority?: 'high' | 'medium' | 'low';
    alwaysAccept?: boolean;
  };
}

export type ACPInputSchema = {
  type?: string;
  properties?: Record<string, ACPInputSchema>;
  required?: string[];
  items?: ACPInputSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

// --- Content blocks ---
export type ContentBlock =
  | ACPTextContent
  | ACPResourceContent
  | ACPImageContent
  | ACPProgressContent;

export interface ACPTextContent {
  type: 'text';
  text: string;
}

export interface ACPResourceContent {
  type: 'resource';
  resource: {
    type: string;
    uri: string;
    data?: string;
    mimeType?: string;
  };
}

export interface ACPImageContent {
  type: 'image';
  data: string; // base64
  mimeType?: string;
}

export interface ACPProgressContent {
  type: 'progress';
  id: string;
  label?: string;
  message?: string;
  messages?: string[];
}

// --- Tool calls ---
export interface ACPToolCallRequest {
  method: 'tools/call';
  id: string | number;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ACPToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export type ACPToolCallResponse = {
  method: 'tools/call';
  id: string | number;
  result: ACPToolResult;
};

// --- Session list ---
export interface ACPSessionInfo {
  sessionId: string;
  path: string;
  title?: string;
  modelId?: string;
  createdAt: string;
  lastActiveAt: string;
}

// --- Agent plan ---
export interface ACPPlanStep {
  id: string;
  description: string;
  status?: 'pending' | 'running' | 'completed' | 'skipped';
}

export interface ACPPlanContent {
  type: 'plan';
  plan: {
    steps: ACPPlanStep[];
  };
}

// --- Session modes ---
export type ACPSessionMode = 'agent' | 'chat' | 'edit' | 'preview';

// --- Cancels ---
export interface ACPCancelParams {
  reason?: string;
}

// --- Type utilities ---
type RequiredPick<T, K extends keyof T> = Pick<T, K> & Partial<Omit<T, K>>;
