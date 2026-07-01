/**
 * SkillsList — the skill list shown in the SidePanel when Skills activity is active.
 * When a skill is clicked, it opens in the main content area (SkillDetailView).
 */

import { FileText, Plus, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';

interface SkillInfo {
  name: string;
  description: string;
  version: string;
  source: string;
  sourceUrl: string;
  ref: string;
  path: string;
  trigger: string;
  scope: string[];
}

type ScopeFilter = 'all' | 'project' | 'user' | 'bundled' | 'foreign';

const SCOPE_LABELS: Record<string, string> = {
  project: 'Project',
  user: 'Global',
  bundled: 'Bundled',
  foreign: 'Foreign',
};

/** Bucket a skill source for grouping. project/user/bundled map to themselves; everything else (.claude/*, extra) → foreign. */
function bucketForSource(source: string | undefined): 'project' | 'user' | 'bundled' | 'foreign' {
  if (source === 'project' || source === 'user' || source === 'bundled') return source;
  return 'foreign';
}

function ScopeBadge({ source }: { source: string }) {
  const scope = bucketForSource(source);
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide',
        scope === 'project' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
        scope === 'user' && 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400',
        scope === 'bundled' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
        scope === 'foreign' && 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
      )}
    >
      {SCOPE_LABELS[scope] ?? scope}
    </span>
  );
}

export function SkillsList({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const skillsState = useUIStore((s) => s.skillsState);
  const setSkillsState = useUIStore((s) => s.setSkillsState);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Always-accessible ref to current skillsState
  const skillsStateRef = useRef(skillsState);
  skillsStateRef.current = skillsState;

  // Install modal state
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [installRef, setInstallRef] = useState('');
  const [installGlobal, setInstallGlobal] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);

  // Create skill modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createScope, setCreateScope] = useState<'project' | 'global'>('project');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Export all state
  const [exportingAll, setExportingAll] = useState(false);

  // Check for updates state
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  // Handle install
  const handleInstallSkill = useCallback(async () => {
    if (!client || !installRef.trim()) return;
    setInstalling(true);
    setInstallError(null);
    setInstallSuccess(null);

    const handler = (msg: unknown) => {
      const m = msg as { payload: { success: boolean; error: string | null; results?: Array<{ name: string }> } };
      setInstalling(false);
      if (m.payload.success) {
        const names = m.payload.results?.map((r) => r.name).join(', ') ?? installRef;
        setInstallSuccess(`Installed: ${names}`);
        client.send({ type: 'skills.list' });
      } else {
        setInstallError(m.payload.error ?? 'Installation failed');
      }
      client.off('skills.installed', handler as (msg: unknown) => void);
    };

    client.on('skills.installed', handler as (msg: unknown) => void);
    client.installSkill(installRef.trim(), installGlobal);
  }, [client, installRef, installGlobal]);

  // Handle create
  const handleCreateSkill = useCallback(() => {
    if (!client || !createName.trim() || !createDescription.trim()) return;
    setCreating(true);
    setCreateError(null);
    setCreateSuccess(null);

    const handler = (msg: unknown) => {
      const m = msg as { payload: { success: boolean; error: string | null; skill?: { name: string; path: string; scope: string } } };
      setCreating(false);
      if (m.payload.success) {
        setCreateSuccess(`Created: ${m.payload.skill?.name}`);
        client.send({ type: 'skills.list' });
      } else {
        setCreateError(m.payload.error ?? 'Creation failed');
      }
      client.off('skills.created', handler as (msg: unknown) => void);
    };

    client.on('skills.created', handler as (msg: unknown) => void);
    client.createSkill(createName.trim(), createDescription.trim(), createScope);
  }, [client, createName, createDescription, createScope]);

  // Handle refresh all
  const handleRefreshAll = useCallback(() => {
    if (!client) return;
    setCheckingForUpdates(true);
    client.checkForUpdates(undefined, undefined);
  }, [client]);

  // Handle export all
  const handleExportAll = useCallback(() => {
    if (!client) return;
    setExportingAll(true);
    const handler = (msg: unknown) => {
      const m = msg as { payload: { zipBase64: string; skillCount: number; error?: string } };
      setExportingAll(false);
      if (m.payload.error) {
        console.error('[skills.export]', m.payload.error);
      } else {
        const binary = atob(m.payload.zipBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wrongstack-skills-${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      client.off('skills.exported', handler as (msg: unknown) => void);
    };
    client.on('skills.exported', handler as (msg: unknown) => void);
    client.exportAllSkills();
  }, [client]);

  // Load skills on mount
  useEffect(() => {
    if (!client) return;
    setLoading(true);

    const handleSkillsList = (msg: unknown) => {
      const m = msg as { payload: { enabled: boolean; skills: SkillInfo[]; error?: string } };
      if (m.payload.enabled && m.payload.skills) {
        setSkills(m.payload.skills);

        // Compute updateAvailableCount
        const currentState = skillsStateRef.current;
        const knownRefs = currentState.knownRefs;
        let updateCount = 0;
        const newKnownRefs = { ...knownRefs };
        for (const skill of m.payload.skills) {
          if (skill.source === 'bundled') continue;
          const currentRef = skill.ref;
          if (!currentRef) continue;
          const knownRef = knownRefs[skill.name];
          newKnownRefs[skill.name] = currentRef;
          if (knownRef && knownRef !== currentRef) {
            updateCount++;
          }
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: updateCount,
        });
      }
      setLoading(false);
    };

    const handleSkillsUpdated = (msg: unknown) => {
      const m = msg as {
        payload: {
          success: boolean;
          error: string | null;
          updated?: Array<{ name: string; oldRef: string; newRef: string }>;
          unchanged?: string[];
          errors?: Array<{ name: string; error: string }>;
        };
      };
      setCheckingForUpdates(false);
      if (m.payload.success) {
        const currentState = skillsStateRef.current;
        const newKnownRefs = { ...currentState.knownRefs };
        for (const u of m.payload.updated ?? []) {
          newKnownRefs[u.name] = u.newRef;
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: 0,
        });
        client.send({ type: 'skills.list' });
      }
    };

    client.on('skills.list', handleSkillsList as (msg: unknown) => void);
    client.on('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    client.send({ type: 'skills.list' });

    return () => {
      client.off('skills.list', handleSkillsList as (msg: unknown) => void);
      client.off('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    };
  }, [client, setSkillsState]);

  // Handle skill click — open in main content area
  const handleSelectSkill = useCallback(
    (skill: SkillInfo) => {
      setSkillsState({
        ...skillsStateRef.current,
        selectedSkill: skill,
        navHistory: [skill],
        historyIndex: 0,
        detailOpen: true,
      });
      showPanel('skills');
    },
    [setSkillsState],
  );

  const filteredSkills = useMemo(() => {
    let result = skills;

    if (scopeFilter !== 'all') {
      result = result.filter((s) => bucketForSource(s.source) === scopeFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.trigger.toLowerCase().includes(q),
      );
    }

    return result;
  }, [skills, scopeFilter, searchQuery]);

  const groupedSkills = useMemo(() => {
    const groups: Record<string, SkillInfo[]> = {
      project: [],
      user: [],
      foreign: [],
      bundled: [],
    };
    for (const skill of filteredSkills) {
      groups[bucketForSource(skill.source)].push(skill);
    }
    return groups;
  }, [filteredSkills]);

  const selectedSkillName = skillsState.selectedSkill?.name;

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden', className)}>
      {/* Icon rail */}
      <div className="w-full border-b flex items-center gap-1 px-2 py-2">
        <button
          type="button"
          onClick={() => {
            setInstallRef('');
            setInstallError(null);
            setInstallSuccess(null);
            setInstallGlobal(false);
            setInstallModalOpen(true);
          }}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Install skill"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setCreateName('');
            setCreateDescription('');
            setCreateScope('project');
            setCreateError(null);
            setCreateSuccess(null);
            setCreateModalOpen(true);
          }}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Create skill"
        >
          <FileText className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleExportAll}
          disabled={exportingAll || skills.length === 0}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
          title="Export all skills as .zip"
        >
          {exportingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={handleRefreshAll}
          disabled={checkingForUpdates}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 relative"
          title="Check for updates (all skills)"
        >
          {checkingForUpdates ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {!checkingForUpdates && skillsState.updateAvailableCount > 0 && (
            <span className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-primary text-[8px] font-bold text-primary-foreground flex items-center justify-center">
              {skillsState.updateAvailableCount > 9 ? '9+' : skillsState.updateAvailableCount}
            </span>
          )}
        </button>
      </div>

      {/* Search + filter */}
      <div className="p-2 space-y-2 border-b shrink-0">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search skills…"
          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-1 flex-wrap">
          {(['all', 'project', 'user', 'foreign', 'bundled'] as ScopeFilter[]).map((scope) => {
            const count = scope === 'all' ? filteredSkills.length : filteredSkills.filter((s) => bucketForSource(s.source) === scope).length;
            return (
              <button
                key={scope}
                type="button"
                onClick={() => setScopeFilter(scope)}
                className={cn(
                  'px-1.5 py-0.5 text-[10px] rounded transition-colors',
                  scopeFilter === scope
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent',
                )}
              >
                {scope === 'all' ? 'All' : SCOPE_LABELS[scope]}
                <span
                  className={cn(
                    'ml-1 font-medium',
                    scopeFilter === scope ? 'opacity-90' : 'opacity-60',
                    count === 0 && 'line-through',
                  )}
                >
                  ({count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Skill list */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-muted-foreground text-center">Loading…</div>
        ) : filteredSkills.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground text-center">
            {skills.length === 0 ? 'No skills installed' : 'No skills match filter'}
          </div>
        ) : (
          <div className="py-1">
            {(['project', 'user', 'foreign', 'bundled'] as const).map((scope) => {
              const group = groupedSkills[scope];
              if (group.length === 0) return null;
              return (
                <div key={scope}>
                  <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <ScopeBadge source={scope} />
                    <span className="ml-auto opacity-60">{group.length}</span>
                  </div>
                  {group.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => handleSelectSkill(skill)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 text-xs transition-colors',
                        selectedSkillName === skill.name
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-accent/50 text-foreground',
                      )}
                    >
                      <div className="font-medium truncate flex items-center gap-1">
                        <Sparkles className="h-3 w-3 shrink-0" />
                        {skill.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                        {skill.trigger || skill.description?.slice(0, 50) || 'No description'}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Install skill modal ── */}
      {installModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setInstallModalOpen(false);
          }}
        >
          <div className="flex max-h-[calc(100dvh-2rem)] w-[420px] max-w-[90vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
            <div className="flex shrink-0 items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">Install Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setInstallModalOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Enter a GitHub repository reference (<span className="font-mono text-[10px]">owner/repo</span>) or full URL.
              </p>
              <input
                type="text"
                value={installRef}
                onChange={(e) => {
                  setInstallRef(e.target.value);
                  setInstallError(null);
                  setInstallSuccess(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !installing) handleInstallSkill();
                }}
                placeholder="e.g. wrongstack/skill-name or https://github.com/owner/repo"
                className="w-full px-3 py-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />

              {/* Scope toggle */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Install scope:</label>
                <div className="flex rounded border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setInstallGlobal(false)}
                    className={cn(
                      'px-2 py-1 text-[10px] transition-colors',
                      !installGlobal ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
                    )}
                  >
                    Project
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstallGlobal(true)}
                    className={cn(
                      'px-2 py-1 text-[10px] transition-colors border-l border-border',
                      installGlobal ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
                    )}
                  >
                    Global
                  </button>
                </div>
              </div>

              {installError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{installError}</p>
              )}
              {installSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded px-2 py-1">{installSuccess}</p>
              )}
            </div>

            <div className="flex shrink-0 justify-end gap-2 p-4 border-t bg-muted/20">
              <button
                type="button"
                onClick={() => setInstallModalOpen(false)}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors"
              >
                {installSuccess ? 'Close' : 'Cancel'}
              </button>
              {!installSuccess && (
                <button
                  type="button"
                  onClick={handleInstallSkill}
                  disabled={installing || !installRef.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {installing && <Loader2 className="h-3 w-3 animate-spin" />}
                  Install
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create skill modal ── */}
      {createModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreateModalOpen(false);
          }}
        >
          <div className="flex max-h-[calc(100dvh-2rem)] w-[480px] max-w-[90vw] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
            <div className="flex shrink-0 items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">Create Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Scaffold a new skill. The first line is the trigger; additional lines form the description.
              </p>

              {/* Skill name */}
              <div>
                <label className="block text-xs font-medium mb-1">
                  Name <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => {
                    const val = e.target.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    setCreateName(val);
                    setCreateError(null);
                    setCreateSuccess(null);
                  }}
                  placeholder="e.g. my-new-skill"
                  className="w-full px-3 py-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                  autoFocus
                />
              </div>

              {/* Description / trigger */}
              <div>
                <label className="block text-xs font-medium mb-1">
                  Description / Trigger <span className="text-destructive">*</span>
                </label>
                <textarea
                  value={createDescription}
                  onChange={(e) => {
                    setCreateDescription(e.target.value);
                    setCreateError(null);
                    setCreateSuccess(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !creating) handleCreateSkill();
                  }}
                  placeholder={'Use this skill when <trigger situation>.\nTriggers: user says "keyword", "another".'}
                  rows={4}
                  className="w-full px-3 py-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                />
              </div>

              {/* Scope toggle */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Save in:</label>
                <div className="flex rounded border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setCreateScope('project')}
                    className={cn(
                      'px-2 py-1 text-[10px] transition-colors',
                      createScope === 'project' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
                    )}
                  >
                    Project
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateScope('global')}
                    className={cn(
                      'px-2 py-1 text-[10px] transition-colors border-l border-border',
                      createScope === 'global' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
                    )}
                  >
                    Global
                  </button>
                </div>
              </div>

              {createError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{createError}</p>
              )}
              {createSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded px-2 py-1">{createSuccess}</p>
              )}
            </div>

            <div className="flex shrink-0 justify-end gap-2 p-4 border-t bg-muted/20">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors"
              >
                {createSuccess ? 'Close' : 'Cancel'}
              </button>
              {!createSuccess && (
                <button
                  type="button"
                  onClick={handleCreateSkill}
                  disabled={creating || !createName.trim() || !createDescription.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                  Create Skill
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
