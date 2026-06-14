/**
 * AgentsDrawer — bottom slide-up drawer (80% width) showing agents monitor content.
 */

import { Bot, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFleetStore } from '@/stores';
import { AgentCard } from './AgentsMonitor';
import { cn } from '@/lib/utils';

interface AgentsDrawerProps {
  onClose: () => void;
}

export function AgentsDrawer({ onClose }: AgentsDrawerProps) {
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);

  const [selectedIdx, setSelectedIdx] = useState(0);

  const fleetList = useMemo(() => {
    const arr = Array.from(fleetAgents.values());
    arr.sort((x, y) => {
      if (x.id === leaderId) return -1;
      if (y.id === leaderId) return 1;
      const xa = x.status === 'running' ? 0 : 1;
      const ya = y.status === 'running' ? 0 : 1;
      if (xa !== ya) return xa - ya;
      return x.startedAt - y.startedAt;
    });
    return arr;
  }, [fleetAgents, leaderId]);

  const selectedAgent = fleetList[selectedIdx] ?? null;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, fleetList.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
    },
    [fleetList.length, onClose],
  );

  useEffect(() => {
    const handleGlobal = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleGlobal);
    return () => window.removeEventListener('keydown', handleGlobal);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Drawer panel */}
      <div
        className="relative w-[80vw] max-w-4xl bg-card border-t border-l border-r rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh] animate-drawer-up"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-card/80 backdrop-blur shrink-0 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold">Agents Monitor</h2>
            <span className="text-xs text-muted-foreground">{fleetList.length} total</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedIdx((i) => Math.max(i - 1, 0))}
              className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-30"
              disabled={selectedIdx === 0}
              aria-label="Previous agent"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs tabular-nums text-muted-foreground font-mono">
              {fleetList.length > 0 ? `${selectedIdx + 1}/${fleetList.length}` : '0/0'}
            </span>
            <button
              type="button"
              onClick={() => setSelectedIdx((i) => Math.min(i + 1, fleetList.length - 1))}
              className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-30"
              disabled={selectedIdx >= fleetList.length - 1}
              aria-label="Next agent"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors ml-1"
              aria-label="Close agents drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {fleetList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Bot className="h-12 w-12 mb-3 opacity-20" />
              <p className="text-sm font-medium">No agents active</p>
            </div>
          ) : selectedAgent ? (
            <div className="max-w-2xl mx-auto">
              <AgentCard agent={selectedAgent} isLeader={selectedAgent.id === leaderId} />
            </div>
          ) : null}
        </div>

        {/* Agent selector strip */}
        {fleetList.length > 0 && (
          <div className="border-t bg-card/80 backdrop-blur shrink-0 px-4 py-2">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {fleetList.map((agent, i) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedIdx(i)}
                  className={cn(
                    'shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] transition-colors',
                    i === selectedIdx
                      ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                      : 'hover:bg-accent text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'led shrink-0',
                      agent.status === 'running' ? 'bg-emerald-500 led-pulse' : agent.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground',
                    )}
                  />
                  <span>{agent.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
