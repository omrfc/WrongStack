/**
 * SessionsDashboard — live session viewer for the WebUI.
 *
 * Fetches GET /api/sessions every 5s and renders a card-based dashboard
 * showing every active WrongStack session across processes, with per-agent
 * status, git branch, working directory, and elapsed time.
 *
 * Usage: <SessionsDashboard /> — standalone, no store dependencies.
 */
import { Clock, Cpu, FolderGit2, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────

interface LiveAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

interface LiveSession {
  sessionId: string;
  projectName: string;
  projectSlug: string;
  projectRoot?: string;
  workingDir: string;
  gitBranch?: string;
  status: string;
  pid: number;
  startedAt: string;
  agentCount: number;
  agents: LiveAgent[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function agentIcon(status: string): string {
  switch (status) {
    case 'running': return '▶';
    case 'streaming': return '↻';
    case 'waiting_user': return '⏳';
    case 'error': return '✗';
    case 'idle': return '■';
    default: return '?';
  }
}

function agentColor(status: string): string {
  switch (status) {
    case 'running': return 'text-emerald-400';
    case 'streaming': return 'text-cyan-400';
    case 'waiting_user': return 'text-amber-400';
    case 'error': return 'text-red-400';
    default: return 'text-slate-500';
  }
}

function sessionColor(status: string): string {
  switch (status) {
    case 'active': return 'text-emerald-400';
    case 'idle': return 'text-cyan-400';
    case 'closing': return 'text-amber-400';
    default: return 'text-slate-500';
  }
}

function fmtDuration(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

// ── Component ──────────────────────────────────────────────────────────

export function SessionsDashboard() {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        if (res.status === 404) {
          // API not available — server might be running without session support
          setError(null);
          setSessions([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as LiveSession[];
      setSessions(data);
      setError(null);
    } catch (err) {
      // Silently fail — the API might not be wired yet
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
    const t = setInterval(fetchSessions, 5000);
    return () => clearInterval(t);
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sessions...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-slate-500 text-sm">
        Session API unavailable — run <code className="text-cyan-400">wstack --webui</code> with session tracking enabled.
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-slate-500 text-sm">
        No live sessions. Open another wstack instance to see it here.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
          Live Sessions ({sessions.length})
        </h2>
        <span className="text-xs text-slate-500">auto-refresh every 5s</span>
      </div>

      {sessions.map((s) => (
        <div
          key={s.sessionId}
          className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2"
        >
          {/* Session header */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={sessionColor(s.status)}>
              {s.status === 'active' ? <Wifi className="h-3.5 w-3.5 inline" /> : s.status === 'idle' ? <WifiOff className="h-3.5 w-3.5 inline" /> : null}
            </span>
            <span className="font-medium text-slate-200 text-sm">{s.projectName}</span>
            <span className="text-slate-500 text-xs">[{s.projectSlug}]</span>
            {s.gitBranch ? (
              <span className="text-purple-400 text-xs flex items-center gap-1">
                <FolderGit2 className="h-3 w-3" />
                {s.gitBranch}
              </span>
            ) : null}
            <span className="text-slate-500 text-xs ml-auto flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtDuration(s.startedAt)}
            </span>
            <span className="text-slate-600 text-xs">PID {s.pid}</span>
          </div>

          {/* Working directory */}
          <div className="text-slate-500 text-xs flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            {s.workingDir}
          </div>

          {/* Agents */}
          <div className="space-y-1 mt-2">
            {s.agents.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs pl-2 border-l-2 border-slate-700">
                <span className={agentColor(a.status)}>
                  {agentIcon(a.status)}
                </span>
                <span className="text-slate-300 font-medium">{a.name}</span>
                {a.currentTool ? (
                  <span className="text-slate-500">[{a.currentTool}]</span>
                ) : null}
                <span className="text-slate-600 ml-auto">
                  {a.iterations} iter · {a.toolCalls} tools · {fmtTimeAgo(a.lastActivityAt)}
                </span>
              </div>
            ))}
            {s.agents.length > 5 ? (
              <div className="text-slate-600 text-xs pl-4">
                ... and {s.agents.length - 5} more
              </div>
            ) : null}
            {s.agents.length === 0 ? (
              <div className="text-slate-600 text-xs pl-4">No agents</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
