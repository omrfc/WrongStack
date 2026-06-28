import type { LiveSession } from '@/stores/monitor-store';
import type { SubagentEvent } from '@/stores';
import { useFleetStore, useMonitorStore, useWorktreeStore } from '@/stores';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WorktreeHandleView, WorktreeOrphanView, WSServerMessage } from '@/types';

export function handleWorktreeState(msg: WSServerMessage) {
  const p = msg.payload as { worktrees: WorktreeHandleView[]; baseBranch: string };
  useWorktreeStore.getState().setSnapshot(p.worktrees ?? [], p.baseBranch ?? '');
}

export function handleWorktreeEvent(msg: WSServerMessage) {
  const p = msg.payload as { kind: string; handleId: string; text: string; at: number };
  useWorktreeStore.getState().pushEvent(p);
}

export function handleWorktreeOrphans(msg: WSServerMessage) {
  const p = msg.payload as { orphans: WorktreeOrphanView[]; canClean: boolean; reason?: string };
  useWorktreeStore.getState().setOrphans(p.orphans ?? [], p.canClean ?? false, p.reason);
}

export function handleWorktreeCleanupResult(msg: WSServerMessage) {
  const p = msg.payload as { ok: boolean; removed: number; reason?: string };
  useWorktreeStore.getState().setCleanResult({ ...p, at: Date.now() });
}

export function handleSubagentEvent(msg: WSServerMessage) {
  useFleetStore.getState().applyEvent(msg.payload as SubagentEvent);
  const vizEv = wsToVizEvent('subagent.event', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export function handleFleetConcurrency(msg: WSServerMessage) {
  const p = msg.payload as { fleetConcurrency: number; fleetConcurrencyMax: number };
  useFleetStore.setState({
    fleetConcurrency: p.fleetConcurrency,
    fleetConcurrencyMax: p.fleetConcurrencyMax,
  });
}

export function handleClientStatusUpdate(msg: WSServerMessage) {
  const payload = msg.payload as {
    clientType?: string;
    clientId?: string;
    agentCount?: number;
    model?: string;
    mode?: string;
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    costUsd?: number;
    timestamp?: number;
  };

  useMonitorStore.getState().setCurrentSession({
    clientType: payload.clientType,
    clientId: payload.clientId,
    agentCount: payload.agentCount,
    model: payload.model,
    mode: payload.mode,
    toolCalls: payload.toolCalls,
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    cacheTokens: payload.cacheTokens,
    costUsd: payload.costUsd,
    timestamp: payload.timestamp,
  });
}

export function handleSessionsStatusUpdate(msg: WSServerMessage) {
  const payload = msg.payload as { sessions?: LiveSession[] } | undefined;
  useMonitorStore.getState().setLiveSessions(payload?.sessions ?? []);

  const vizEv = wsToVizEvent('sessions.status_update', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export const fleetHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'worktree.state': handleWorktreeState,
  'worktree.event': handleWorktreeEvent,
  'worktree.orphans': handleWorktreeOrphans,
  'worktree.cleanup_result': handleWorktreeCleanupResult,
  'subagent.event': handleSubagentEvent,
  'fleet.concurrency_update': handleFleetConcurrency,
  'client.status_update': handleClientStatusUpdate,
  'sessions.status_update': handleSessionsStatusUpdate,
};
