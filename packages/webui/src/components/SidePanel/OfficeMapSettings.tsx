/**
 * OfficeMapSettings — Settings and controls panel for the Office Map.
 *
 * Rendered in the SidePanel when the Office Map is active, replacing
 * the map itself which now lives in the full-width main area.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  useFleetStore,
  useMailboxStore,
  useVizStore,
} from '@/stores';

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-1',
        )}
      />
    </button>
  );
}

export function OfficeMapSettings() {
  const fleetAgents = useFleetStore((s) => s.agents);
  const vizEvents = useVizStore((s) => s.events);
  const mailboxMessages = useMailboxStore((s) => s.messages);

  // Local settings state
  const [showMinimap, setShowMinimap] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [animateEdges, setAnimateEdges] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [autoFit, setAutoFit] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);

  const runningAgents = Array.from(fleetAgents.values()).filter((a) => a.status === 'running').length;
  const totalAgents = fleetAgents.size;
  const unreadMessages = mailboxMessages.filter((m) => !m.completed && (m.readByCount ?? 0) === 0).length;
  const recentEvents = vizEvents.slice(0, 10).length;

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Office Map</h3>
        <p className="text-[10px] text-muted-foreground">
          Visualize your fleet as an office floor plan with live agent status.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border bg-card p-2.5">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Agents</div>
          <div className="text-lg font-mono font-bold text-primary mt-0.5">
            {runningAgents}
            <span className="text-muted-foreground text-sm font-normal">/{totalAgents}</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-2.5">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Mail</div>
          <div className="text-lg font-mono font-bold text-yellow-500 mt-0.5">
            {unreadMessages}
            <span className="text-muted-foreground text-sm font-normal"> unread</span>
          </div>
        </div>
      </div>

      {/* View Settings */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          View
        </div>
        <div className="rounded-lg border bg-card divide-y">
          <SettingRow label="Minimap" description="Show the overview minimap">
            <Toggle
              checked={showMinimap}
              onChange={setShowMinimap}
              label="Toggle minimap"
            />
          </SettingRow>
          <SettingRow label="Controls" description="Show zoom and fit controls">
            <Toggle
              checked={showControls}
              onChange={setShowControls}
              label="Toggle controls"
            />
          </SettingRow>
          <SettingRow label="Auto-fit view" description="Automatically fit all nodes on changes">
            <Toggle
              checked={autoFit}
              onChange={setAutoFit}
              label="Toggle auto-fit"
            />
          </SettingRow>
        </div>
      </div>

      {/* Display Settings */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Display
        </div>
        <div className="rounded-lg border bg-card divide-y">
          <SettingRow label="Animate edges" description="Animate flow on active connections">
            <Toggle
              checked={animateEdges}
              onChange={setAnimateEdges}
              label="Toggle edge animation"
            />
          </SettingRow>
          <SettingRow label="Show labels" description="Display connection type labels">
            <Toggle
              checked={showLabels}
              onChange={setShowLabels}
              label="Toggle labels"
            />
          </SettingRow>
        </div>
      </div>

      {/* Zoom Level */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Zoom
        </div>
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Zoom level</span>
            <span className="font-mono">{Math.round(zoomLevel * 100)}%</span>
          </div>
          <input
            type="range"
            min="30"
            max="150"
            value={zoomLevel * 100}
            onChange={(e) => setZoomLevel(Number(e.target.value) / 100)}
            className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>30%</span>
            <span>150%</span>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Activity
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs font-mono">
            <span className="text-primary">{recentEvents}</span>
            <span className="text-muted-foreground"> events tracked</span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Mail sends, agent spawns, and status changes appear here.
          </p>
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Shortcuts
        </div>
        <div className="rounded-lg border bg-card p-3 space-y-2 text-[10px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fit view</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono">F</kbd>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Zoom in</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono">+</kbd>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Zoom out</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono">-</kbd>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Reset zoom</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono">0</kbd>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Legend
        </div>
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs">Active (running)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-500" />
            <span className="text-xs">Idle</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs">Error</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-600" />
            <span className="text-xs">Offline</span>
          </div>
        </div>
      </div>
    </div>
  );
}
