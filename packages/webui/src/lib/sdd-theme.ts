/**
 * Shared SDD design system — the single source of truth for status/priority
 * visuals and small formatters across every SDD surface (flow graph, kanban,
 * task drawer, activity feed, board header). Keeping these here instead of
 * re-declaring per component prevents the colours/labels/icons from drifting
 * apart as the views evolve.
 */
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  CircleDot,
  GitMerge,
  Layers,
  Loader2,
  type LucideIcon,
  Play,
  RotateCcw,
  ShieldAlert,
  Split,
  X,
} from 'lucide-react';

export type SddStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'failed'
  | 'completed'
  | 'cancelled';

export interface SddStatusStyle {
  /** Short label, e.g. "Running". */
  label: string;
  /** Lucide icon for the status. */
  icon: LucideIcon;
  /** True for the running state (drives spin + glow). */
  spin?: boolean;
  /** Tailwind text-colour class. */
  text: string;
  /** Tailwind border+bg ring for chips/badges. */
  ring: string;
  /** Tailwind background class for a small status dot. */
  dot: string;
  /** Raw hex (React Flow edges / minimap — they can't take Tailwind classes). */
  hex: string;
}

export const SDD_STATUS: Record<SddStatus, SddStatusStyle> = {
  pending: {
    label: 'Pending',
    icon: CircleDot,
    text: 'text-slate-500 dark:text-slate-400',
    ring: 'border-slate-400/50 bg-slate-400/10 dark:border-slate-600/50 dark:bg-slate-700/20',
    dot: 'bg-slate-500',
    hex: '#64748b',
  },
  queued: {
    label: 'Ready',
    icon: CircleDot,
    text: 'text-cyan-600 dark:text-cyan-300',
    ring: 'border-cyan-500/50 bg-cyan-500/10',
    dot: 'bg-cyan-400',
    hex: '#22d3ee',
  },
  in_progress: {
    label: 'Running',
    icon: Loader2,
    spin: true,
    text: 'text-amber-600 dark:text-amber-300',
    ring: 'border-amber-400/60 bg-amber-500/10',
    dot: 'bg-amber-400',
    hex: '#fbbf24',
  },
  blocked: {
    label: 'Blocked',
    icon: CircleDot,
    text: 'text-fuchsia-600 dark:text-fuchsia-300',
    ring: 'border-fuchsia-500/50 bg-fuchsia-500/10',
    dot: 'bg-fuchsia-400',
    hex: '#e879f9',
  },
  review: {
    label: 'Review',
    icon: CircleDot,
    text: 'text-sky-600 dark:text-sky-300',
    ring: 'border-sky-500/50 bg-sky-500/10',
    dot: 'bg-sky-400',
    hex: '#38bdf8',
  },
  failed: {
    label: 'Failed',
    icon: X,
    text: 'text-red-600 dark:text-red-300',
    ring: 'border-red-500/60 bg-red-500/10',
    dot: 'bg-red-400',
    hex: '#f87171',
  },
  completed: {
    label: 'Done',
    icon: Check,
    text: 'text-emerald-600 dark:text-emerald-300',
    ring: 'border-emerald-500/55 bg-emerald-500/10',
    dot: 'bg-emerald-400',
    hex: '#34d399',
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    text: 'text-slate-500 dark:text-slate-400',
    ring: 'border-slate-400/50 bg-slate-400/10 dark:border-slate-500/50 dark:bg-slate-600/20',
    dot: 'bg-slate-500',
    hex: '#94a3b8',
  },
};

export function statusStyle(s: string): SddStatusStyle {
  return SDD_STATUS[s as SddStatus] ?? SDD_STATUS.pending;
}

export type SddPriority = 'critical' | 'high' | 'medium' | 'low';

export const SDD_PRIORITY: Record<SddPriority, { text: string; chip: string }> = {
  critical: {
    text: 'text-red-600 dark:text-red-400',
    chip: 'bg-red-500/20 text-red-600 dark:text-red-300',
  },
  high: {
    text: 'text-amber-600 dark:text-amber-400',
    chip: 'bg-amber-500/20 text-amber-600 dark:text-amber-300',
  },
  medium: {
    text: 'text-cyan-600 dark:text-cyan-400',
    chip: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
  },
  low: {
    text: 'text-slate-500 dark:text-slate-400',
    chip: 'bg-slate-400/20 text-slate-600 dark:bg-slate-600/30 dark:text-slate-400',
  },
};

export function priorityStyle(p: string) {
  return SDD_PRIORITY[p as SddPriority] ?? SDD_PRIORITY.medium;
}

/** Run-level status badge styles (board header). */
export const SDD_RUN_STATUS: Record<string, string> = {
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  paused: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
  deadlocked: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
  idle: 'border-border bg-muted text-muted-foreground',
};

/** Deterministic palette for agent avatars (indexed by roster position). */
export const SDD_AGENT_COLORS = [
  'bg-amber-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-fuchsia-500',
];

/** Activity-feed entry kinds → icon + colour. */
export const SDD_FEED_KIND: Record<string, { icon: LucideIcon; color: string }> = {
  started: { icon: Play, color: 'text-amber-400' },
  completed: { icon: Check, color: 'text-emerald-400' },
  failed: { icon: X, color: 'text-red-400' },
  retrying: { icon: RotateCcw, color: 'text-orange-400' },
  wave: { icon: Layers, color: 'text-violet-400' },
  deadlock: { icon: AlertTriangle, color: 'text-rose-400' },
  verification_failed: { icon: ShieldAlert, color: 'text-red-400' },
  conflict: { icon: GitMerge, color: 'text-amber-400' },
  split: { icon: Split, color: 'text-sky-400' },
  supervisor: { icon: Brain, color: 'text-fuchsia-400' },
};

// ── formatters ────────────────────────────────────────────────────────────

/** Two-letter avatar initials from a worker name. */
export function agentInitials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '·';
}

/** Compact duration, e.g. "2m 5s" / "12s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Compact relative age, e.g. "5s" / "3m" / "2h". */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
