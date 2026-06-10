import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { Folder, History, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface ProjectEntry {
  name: string;
  root: string;
  slug: string;
  lastSeen?: string | undefined;
}

/**
 * Projects panel — reads from ~/.wrongstack/projects.json via the backend.
 * Shows all known projects with names, paths, and last-seen times.
 *
 * When `fullView` is true, renders as a standalone sidebar panel with a
 * header. When false (default), renders as a compact subsection suitable
 * for embedding in the Settings panel.
 */
export function ProjectsPanel({ fullView }: { fullView?: boolean | undefined }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const ws = getWSClient();
    const off = ws.on('projects.list', (msg) => {
      const p = msg.payload as { projects: ProjectEntry[] };
      setProjects(p.projects ?? []);
      setLoading(false);
    });
    ws.send({ type: 'projects.list' });
    return () => off();
  }, []);

  const fmtLastSeen = (iso?: string | undefined): string => {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  if (loading) {
    const spinner = (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
    if (fullView) return <div className="h-full flex flex-col overflow-hidden"><div className="px-3 py-2 border-b"><h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</h2></div><div className="flex-1 flex items-center justify-center">{spinner}</div></div>;
    return spinner;
  }

  if (projects.length === 0) {
    const empty = (
      <div className="text-xs text-muted-foreground italic py-2">
        No projects registered. Run <code className="font-mono bg-muted/40 px-1 rounded">wstack</code> in a directory to register it.
      </div>
    );
    if (fullView) return <div className="h-full flex flex-col overflow-hidden"><div className="px-3 py-2 border-b"><h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</h2></div><div className="flex-1 flex items-center justify-center">{empty}</div></div>;
    return empty;
  }

  // Sort by lastSeen descending
  const sorted = [...projects].sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.name.localeCompare(b.name);
  });

  const list = (
    <div className={cn('space-y-1', fullView && 'p-2')}>
      {sorted.map((p) => (
        <div
          key={p.slug}
          className="flex items-start gap-2 px-2 py-1.5 rounded border bg-card/40 text-xs"
        >
          <Folder className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">{p.name}</div>
            <div className="font-mono text-[10px] text-muted-foreground truncate">
              {p.root}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/60">
              <span className="font-mono">{p.slug}</span>
              {p.lastSeen && (
                <span className="flex items-center gap-1">
                  <History className="h-2.5 w-2.5" />
                  {fmtLastSeen(p.lastSeen)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  if (fullView) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b shrink-0">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</h2>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            Known projects from <code className="font-mono bg-muted/40 px-0.5 rounded">~/.wrongstack/projects.json</code>
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">{list}</div>
        <div className="px-3 py-2 border-t shrink-0">
          <p className="text-[9px] text-muted-foreground/40 text-center">
            Use <code className="font-mono bg-muted/40 px-1 rounded">/project add</code> in the CLI to register projects
          </p>
        </div>
      </div>
    );
  }

  return list;
}
