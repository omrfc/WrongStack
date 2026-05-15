import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Tiny toast store + portal. We resisted pulling in shadcn-ui's full
 * toast/sonner since it brings a tree of providers — this is one store,
 * one component, ~80 lines total. The store is exposed via `toast.success(...)`
 * etc. so non-React modules (ws-client handlers) can fire toasts without
 * the hook.
 */

export type ToastVariant = 'success' | 'error' | 'warn' | 'info';

interface ToastEntry {
  id: string;
  message: string;
  variant: ToastVariant;
  ttl: number;
}

interface ToastState {
  toasts: ToastEntry[];
  push: (t: Omit<ToastEntry, 'id'>) => string;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })),
}));

/** Imperative API. Pass plain strings or arrays of strings for multi-line. */
export const toast = {
  success: (msg: string, ttl = 3500) =>
    useToastStore.getState().push({ message: msg, variant: 'success', ttl }),
  error: (msg: string, ttl = 6000) =>
    useToastStore.getState().push({ message: msg, variant: 'error', ttl }),
  warn: (msg: string, ttl = 4500) =>
    useToastStore.getState().push({ message: msg, variant: 'warn', ttl }),
  info: (msg: string, ttl = 3500) =>
    useToastStore.getState().push({ message: msg, variant: 'info', ttl }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

function Icon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (variant === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
  if (variant === 'warn') return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  return <Info className="h-4 w-4 text-blue-500" />;
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(entry.id), entry.ttl);
    return () => clearTimeout(t);
  }, [entry.id, entry.ttl, dismiss]);
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-popover shadow-lg px-3 py-2 text-sm max-w-sm',
        'animate-message',
        entry.variant === 'error' && 'border-destructive/40',
        entry.variant === 'warn' && 'border-amber-500/40',
        entry.variant === 'success' && 'border-green-500/40',
      )}
    >
      <Icon variant={entry.variant} />
      <div className="flex-1 min-w-0 whitespace-pre-wrap break-words leading-snug">
        {entry.message}
      </div>
      <button
        type="button"
        onClick={() => dismiss(entry.id)}
        className="text-muted-foreground hover:text-foreground"
        title="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto">
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </div>
  );
}
