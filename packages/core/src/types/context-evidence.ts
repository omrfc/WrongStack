export type ToolEvidenceStatus = 'seen' | 'referenced';

export interface ToolOutputMetadata {
  toolUseId: string;
  toolName: string;
  ok: boolean;
  inputSummary?: string | undefined;
  summary: string;
  files: string[];
  symbols: string[];
  commands: string[];
  errors: string[];
  status: ToolEvidenceStatus;
  referenceCount: number;
  seenAt: number;
  referencedAt?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
}

export interface ContextFileEvidence {
  path: string;
  reads: number;
  writes: number;
  tools: string[];
  referenced: boolean;
  lastToolUseId?: string | undefined;
}

export interface ContextIntentEvidence {
  text: string;
  updatedAt: number;
}

export interface ContextRepeatedReadEvidence {
  file: string;
  count: number;
  lastToolUseId: string;
}

export interface ContextEvidenceState {
  currentIntent?: ContextIntentEvidence | undefined;
  sessionGoals: string[];
  implicitFacts: string[];
  activeErrors: string[];
  toolCalls: ToolOutputMetadata[];
  fileGraph: Record<string, ContextFileEvidence>;
  repeatedReads: ContextRepeatedReadEvidence[];
  lastReadPath?: string | undefined;
  updatedAt: number;
}
