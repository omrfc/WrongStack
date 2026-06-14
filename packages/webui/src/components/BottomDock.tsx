/**
 * BottomDock — persistent bottom bar with Fleet and Agents monitor toggle buttons.
 * State persists across page navigation via ui-store (zustand persist).
 */

import { Bot, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFleetStore, useUIStore } from '@/stores';

export function BottomDock() {
  const fleetDrawerOpen = useUIStore((s) => s.fleetDrawerOpen);
  const agentsDrawerOpen = useUIStore((s) => s.agentsDrawerOpen);
  const setFleetDrawerOpen = useUIStore((s) => s.setFleetDrawerOpen);
  const setAgentsDrawerOpen = useUIStore((s) => s.setAgentsDrawerOpen);

  const fleetAgents = useFleetStore((s) => s.agents);
  const fleetRunning = Array.from(fleetAgents.values()).filter((a) => a.status === 'running').length;
  const fleetTotal = fleetAgents.size;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-center gap-2 pb-3 pointer-events-none">
      <div className="flex items-center gap-1 pointer-events-auto">
        {/* Fleet Monitor toggle */}
        <button
          type="button"
          onClick={() => setFleetDrawerOpen(!fleetDrawerOpen)}
          className={cn(
            'flex items-center gap-2 h-8 px-4 rounded-full text-xs font-medium transition-all shadow-lg',
            fleetDrawerOpen
              ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'bg-card/90 backdrop-blur-md border border-border hover:border-emerald-500/40 hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400',
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          Fleet
          {fleetTotal > 0 && (
            <span
              className={cn(
                'tabular-nums text-[10px] px-1.5 py-0.5 rounded-full',
                fleetRunning > 0
                  ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {fleetRunning}/{fleetTotal}
            </span>
          )}
        </button>

        {/* Agents Monitor toggle */}
        <button
          type="button"
          onClick={() => setAgentsDrawerOpen(!agentsDrawerOpen)}
          className={cn(
            'flex items-center gap-2 h-8 px-4 rounded-full text-xs font-medium transition-all shadow-lg',
            agentsDrawerOpen
              ? 'bg-primary/20 border border-primary/40 text-primary'
              : 'bg-card/90 backdrop-blur-md border border-border hover:border-primary/40 hover:bg-primary/10 text-muted-foreground hover:text-primary',
          )}
        >
          <Users className="h-3.5 w-3.5" />
          Agents
          {fleetTotal > 0 && (
            <span className="tabular-nums text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {fleetTotal}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
