// Types, formatting helpers, and layout constants extracted from OfficeMapCanvas.

export type ClientKind = 'webui' | 'tui' | 'repl' | 'coordinator' | 'agent' | 'mailbox';
export type ClientStatus = 'idle' | 'active' | 'streaming' | 'completed' | 'error' | 'offline';

export interface OfficeNodeData extends Record<string, unknown> {
  label: string;
  sublabel?: string;
  kind: ClientKind;
  status: ClientStatus;
  unreadCount?: number;
  messageCount?: number;
  currentTask?: string;
  iteration?: number;
  toolCalls?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  ctxPct?: number;
  model?: string;
  lastActivityAt?: string;
  lastSeenAt?: number;
  connections?: number;
  agentsActive?: number;
  agentsTotal?: number;
  sessionId?: string;
  serverId?: string;
  pid?: number;
  branch?: string;
  workingDir?: string;
  startedAt?: string;
  agentCount?: number;
  color?: string;
  vizActivity?: number;
}

/** Compact token/number formatting: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtCompact(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtAgo(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function fmtUptime(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const parts = model.split('/');
  return parts[parts.length - 1]?.slice(0, 18);
}

// ── Layout constants ──────────────────────────────────────────────────────────

export const CENTER_X = 600;
export const HUB_Y = 50;
export const HUB_GAP = 230;
export const MAILBOX_Y = HUB_Y;
export const COORD_Y = HUB_Y;
export const CLIENT_Y = 370;
export const AGENT_Y0 = 640;
export const CLIENT_COL_W = 380;
export const AGENT_COLS = 3;
export const AGENT_FAN_W = 190;
export const AGENT_ROW_H = 150;

export function layoutClientXs(clientIds: string[], colW: number = CLIENT_COL_W): Map<string, number> {
  const map = new Map<string, number>();
  const n = Math.max(1, clientIds.length);
  clientIds.forEach((id, i) => {
    const offset = (i - (n - 1) / 2) * colW;
    map.set(id, CENTER_X + offset);
  });
  return map;
}

export function agentFanPos(cx: number, j: number, total: number): { x: number; y: number } {
  const cols = Math.min(AGENT_COLS, total);
  const row = Math.floor(j / cols);
  const col = j % cols;
  const inRow = Math.min(cols, total - row * cols);
  const rowWidth = (inRow - 1) * AGENT_FAN_W;
  const x = cx - rowWidth / 2 + col * AGENT_FAN_W;
  const y = AGENT_Y0 + row * AGENT_ROW_H;
  return { x, y };
}

export function clientNodeType(clientType: string | undefined): 'tui' | 'webui' | 'repl' {
  if (clientType === 'tui') return 'tui';
  if (clientType === 'repl' || clientType === 'cli') return 'repl';
  return 'webui';
}

export function surfaceLabel(kind: 'tui' | 'webui' | 'repl'): string {
  return kind === 'tui' ? 'TUI' : kind === 'repl' ? 'REPL' : 'WebUI';
}

export function mapAgentStatus(raw: string | undefined): ClientStatus {
  switch (raw) {
    case 'running':
    case 'active':
      return 'active';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    case 'stopped':
      return 'offline';
    default:
      return 'idle';
  }
}
