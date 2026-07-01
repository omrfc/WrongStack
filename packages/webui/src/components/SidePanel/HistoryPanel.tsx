/**
 * HistoryPanel — the single home for past sessions (the old UI split this
 * across a History section, a Sessions activity, and a dashboard view).
 * The full-page SessionsDashboard stays reachable via the header link.
 */

import { LayoutGrid } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { showPanel } from '@/lib/view-navigation';
import { useConfigStore, useHistoryStore, useSessionStore } from '@/stores';
import { SessionList } from './SessionList';

export function HistoryPanel() {
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { entries, loading, error } = useHistoryStore();
  const { listSessions, resumeSession, deleteSession } = useWebSocket();
  const activeSessionId = useSessionStore((s) => s.session?.id);

  const [query, setQuery] = useState('');

  // Refresh on open and whenever the active session changes (a resume or
  // new session reorders the list).
  useEffect(() => {
    // activeSessionId is a re-run trigger, not an input.
    void activeSessionId;
    if (wsConnected) listSessions(50);
  }, [wsConnected, activeSessionId, listSessions]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <SessionList
        historyQuery={query}
        setHistoryQuery={setQuery}
        historyEntries={entries}
        historyLoading={loading}
        historyError={error}
        wsConnected={wsConnected}
        listSessions={listSessions}
        resumeSession={resumeSession}
        deleteSession={deleteSession}
      />
      <div className="border-t px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={() => showPanel('history')}
          className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <LayoutGrid className="h-3 w-3" />
          Open sessions dashboard
        </button>
      </div>
    </div>
  );
}
