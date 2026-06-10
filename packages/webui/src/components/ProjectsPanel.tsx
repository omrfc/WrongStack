import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { ExternalLink, Folder, FolderPlus, History, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from './Toaster';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface ProjectEntry {
  name: string;
  root: string;
  slug: string;
  lastSeen?: string | undefined;
}

/**
 * Projects panel — reads from ~/.wrongstack/projects.json via the backend.
 * Shows all known projects with names, paths, and last-seen times.
 * Supports registering new projects via a folder-path dialog.
 *
 * When `fullView` is true, renders as a standalone sidebar panel with a
 * header. When false (default), renders as a compact subsection suitable
 * for embedding in the Settings panel.
 */
export function ProjectsPanel({ fullView }: { fullView?: boolean | undefined }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const projectNameRef = useRef<HTMLInputElement>(null);

  const fetchProjects = useCallback(() => {
    const ws = getWSClient();
    ws.send({ type: 'projects.list' });
  }, []);

  useEffect(() => {
    setLoading(true);
    const ws = getWSClient();
    const offList = ws.on('projects.list', (msg) => {
      const p = msg.payload as { projects: ProjectEntry[] };
      setProjects(p.projects ?? []);
      setLoading(false);
    });
    const offAdded = ws.on('projects.added', (msg) => {
      const p = msg.payload as { name: string; root: string; slug: string; message: string };
      if (p.slug) {
        toast.success(p.message);
        fetchProjects();
      } else {
        toast.error(p.message);
      }
    });
    fetchProjects();
    return () => {
      offList();
      offAdded();
    };
  }, [fetchProjects]);

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

  const handleSelect = useCallback((p: ProjectEntry) => {
    const ws = getWSClient();
    ws.send({ type: 'projects.select', payload: { root: p.root, name: p.name } });
    const off = ws.on('projects.selected', (msg) => {
      const payload = msg.payload as { root: string; name: string; message: string };
      off();
      // If the message includes a URL, try to open it in a new tab
      const urlMatch = payload.message.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch && urlMatch[1]) {
        window.open(urlMatch[1], '_blank');
        toast.success(`Opening ${payload.name} in a new tab...`);
      } else {
        toast.info(payload.message);
      }
    });
  }, []);

  const handleAdd = useCallback(() => {
    const trimmed = folderPath.trim();
    if (!trimmed) {
      toast.error('Please enter a folder path.');
      return;
    }
    setAdding(true);
    const ws = getWSClient();
    ws.send({
      type: 'projects.add',
      payload: { root: trimmed, name: projectName.trim() || undefined },
    });
    // Listen for result to clear state
    const off = ws.on('projects.added', () => {
      off();
      setAdding(false);
      setDialogOpen(false);
      setFolderPath('');
      setProjectName('');
    });
  }, [folderPath, projectName]);

  // ── ALL hooks are above this line. Early returns below derive from
  // ── state but do not add or remove hooks across renders. ──────────────

  // Sort by lastSeen descending
  const sorted = [...projects].sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.name.localeCompare(b.name);
  });

  const addButton = (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1 h-7 text-xs"
        >
          <FolderPlus className="h-3 w-3" />
          Register Project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register New Project</DialogTitle>
          <DialogDescription>
            Enter the absolute path to a project folder. The project will be added to{' '}
            <code className="font-mono bg-muted/40 px-1 rounded text-xs">~/.wrongstack/projects.json</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="proj-folder" className="text-xs font-medium text-muted-foreground mb-1 block">
              Folder path
            </label>
            <Input
              id="proj-folder"
              placeholder="/home/user/my-project or C:\Users\me\my-project"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  projectNameRef.current?.focus();
                }
              }}
            />
          </div>
          <div>
            <label htmlFor="proj-name" className="text-xs font-medium text-muted-foreground mb-1 block">
              Project name (optional — defaults to folder name)
            </label>
            <Input
              id="proj-name"
              ref={projectNameRef}
              placeholder="My Project"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialogOpen(false)}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleAdd} disabled={adding || !folderPath.trim()}>
            {adding ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : null}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (loading) {
    const spinner = (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
    if (fullView) {
      return (
        <div className="h-full flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</h2>
          </div>
          <div className="flex-1 flex items-center justify-center">{spinner}</div>
        </div>
      );
    }
    return spinner;
  }

  const list = (
    <div className={cn('space-y-1', fullView && 'p-2')}>
      {sorted.map((p) => (
        <button
          key={p.slug}
          type="button"
          onClick={() => handleSelect(p)}
          className="flex items-start gap-2 w-full text-left px-2 py-1.5 rounded border bg-card/40 text-xs hover:bg-accent hover:border-primary/40 transition-colors"
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
          <ExternalLink className="h-3 w-3 shrink-0 mt-1 text-muted-foreground/40" />
        </button>
      ))}
    </div>
  );

  if (fullView) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Projects
            </h2>
            {addButton}
          </div>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            Known projects from{' '}
            <code className="font-mono bg-muted/40 px-0.5 rounded">
              ~/.wrongstack/projects.json
            </code>
          </p>
        </div>
        {projects.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-muted-foreground italic py-2">
              No projects registered. Use the button above or run{' '}
              <code className="font-mono bg-muted/40 px-1 rounded">wstack</code>{' '}
              in a directory to register it.
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">{list}</div>
        )}
        <div className="px-3 py-2 border-t shrink-0">
          <p className="text-[9px] text-muted-foreground/40 text-center">
            Click a project to open it in a new WebUI tab
          </p>
        </div>
      </div>
    );
  }

  // Compact mode (used inside Settings panel)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {addButton}
      </div>
      {projects.length === 0 ? (
        <div className="text-xs text-muted-foreground italic py-2">
          No projects registered. Use the button above or run{' '}
          <code className="font-mono bg-muted/40 px-1 rounded">wstack</code>{' '}
          in a directory to register it.
        </div>
      ) : (
        list
      )}
    </div>
  );
}
