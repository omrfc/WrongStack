import type { ServerState } from '../types.js';

const ALLOWED: Record<ServerState, ServerState[]> = {
  disabled: ['starting'],
  starting: ['initializing', 'failed', 'exited'],
  initializing: ['ready', 'failed', 'exited'],
  ready: ['shutting_down', 'failed', 'exited'],
  failed: ['reconnecting', 'disabled', 'starting'],
  reconnecting: ['starting', 'failed'],
  shutting_down: ['exited', 'failed'],
  exited: ['starting', 'disabled'],
};

export function canTransition(from: ServerState, to: ServerState): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export function nextReconnectDelay(attempt: number): number {
  /* v8 ignore next -- array fallback is defensive after clamping. */
  return [1000, 4000, 16_000][Math.max(0, Math.min(2, attempt))] ?? 16_000;
}
