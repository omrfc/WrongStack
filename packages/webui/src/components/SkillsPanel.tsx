/**
 * SkillsPanel — displays installed skills with markdown rendering.
 *
 * Shows skills organized by scope (project, user, bundled), with a markdown
 * view that displays the skill content plus references, scripts, and related files.
 */

import { Sparkles, FileText, FolderOpen, X, ChevronRight, BookOpen, ArrowUpRight, ChevronLeft, Plus, Trash2, Download, Loader2, Copy, Check, RefreshCw, Globe, Pencil, PanelRight } from 'lucide-react';
import TextareaCodeEditor from '@uiw/react-textarea-code-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { markdownComponents } from './MessageBubble/utils';

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

interface SkillContent {
  name: string;
  body: string;
  path: string;
  source: string;
  relatedFiles: string[];
  references: string[];
}

type ScopeFilter = 'all' | 'project' | 'user' | 'bundled';

const SCOPE_LABELS: Record<string, string> = {
  project: 'Project',
  user: 'Global',
  bundled: 'Bundled',
};

function ScopeBadge({ source }: { source: string }) {
  let scope: ScopeFilter = 'bundled';
  if (source === 'project') scope = 'project';
  else if (source === 'user') scope = 'user';

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide',
        scope === 'project' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
        scope === 'user' && 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400',
        scope === 'bundled' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
      )}
    >
      {SCOPE_LABELS[scope] ?? scope}
    </span>
  );
}

/** Derive a skill name from a related filename like "api-design/SKILL.save.md" → "api-design" */
function skillNameFromFile(fileName: string): string | null {
  // Pattern: SKILL.md, SKILL.save.md, or any .md that maps to a skill directory
  // e.g. "api-design/SKILL.save.md" → the skill is "api-design"
  const match = fileName.match(/^(.+?)\/SKILL(?:\.save)?\.md$/);
  return match ? match[1] : null;
}

export function SkillsPanel({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const skillsState = useUIStore((s) => s.skillsState);
  const setSkillsState = useUIStore((s) => s.setSkillsState);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(skillsState.selectedSkill);
  const [skillContent, setSkillContent] = useState<SkillContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // Breadcrumb navigation history — initialized from persisted store state
  const [navHistory, setNavHistory] = useState<SkillInfo[]>(skillsState.navHistory);
  const [historyIndex, setHistoryIndex] = useState(skillsState.historyIndex);
  // Whether the detail pane is currently open — synced with store.detailOpen
  const [detailOpen, setDetailOpen] = useState(skillsState.detailOpen);
  // Track if the current navigation was a "back" operation to avoid pushing duplicate entries
  const isNavigatingBack = useRef(false);
  // Whether we've restored from the store on mount (to avoid re-persisting the initial state)
  const didRestore = useRef(false);
  // Always-accessible ref to current skillsState — avoids stale closures in WS message handlers
  const skillsStateRef = useRef(skillsState);
  skillsStateRef.current = skillsState;

  // Install modal state
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [installRef, setInstallRef] = useState('');
  const [installGlobal, setInstallGlobal] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);

  // Uninstall state
  const [uninstallConfirmSkill, setUninstallConfirmSkill] = useState<SkillInfo | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Create skill modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createScope, setCreateScope] = useState<'project' | 'global'>('project');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Copy source URL feedback
  const [copiedSourceUrl, setCopiedSourceUrl] = useState(false);

  // Update check state
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    updated: Array<{ name: string; oldRef: string; newRef: string }>;
    unchanged: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [splitPreview, setSplitPreview] = useState(false);

  // Edit content stats — recomputed only when editContent changes
  const editStats = useMemo(() => {
    if (!editContent) return { lines: 0, words: 0, chars: 0 };
    const lines = editContent.split('\n').length;
    const words = editContent.trim() ? editContent.trim().split(/\s+/).length : 0;
    const chars = editContent.length;
    return { lines, words, chars };
  }, [editContent]);

  // Install a skill from a GitHub ref (owner/repo or URL)
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
        // Refresh the skills list
        client.send({ type: 'skills.list' });
      } else {
        setInstallError(m.payload.error ?? 'Installation failed');
      }
      client.off('skills.installed', handler as (msg: unknown) => void);
    };

    client.on('skills.installed', handler as (msg: unknown) => void);
    client.installSkill(installRef.trim(), installGlobal);
  }, [client, installRef, installGlobal]);

  // Create a new skill from name + description
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
        // Refresh the skills list
        client.send({ type: 'skills.list' });
      } else {
        setCreateError(m.payload.error ?? 'Creation failed');
      }
      client.off('skills.created', handler as (msg: unknown) => void);
    };

    client.on('skills.created', handler as (msg: unknown) => void);
    client.createSkill(createName.trim(), createDescription.trim(), createScope);
  }, [client, createName, createDescription, createScope]);

  // Start editing the current skill's content
  const handleStartEdit = useCallback(() => {
    if (!skillContent) return;
    setEditContent(skillContent.body);
    setEditError(null);
    setEditMode(true);
    setSplitPreview(false);
  }, [skillContent]);

  // Cancel editing and revert to view mode
  const handleCancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
    setEditError(null);
    setSplitPreview(false);
  }, []);

  // Save the edited skill content
  const handleSaveEdit = useCallback(() => {
    if (!client || !selectedSkill || !editContent.trim()) return;
    setEditSaving(true);
    setEditError(null);

    const handler = (msg: unknown) => {
      const m = msg as { payload: { success: boolean; error: string | null } };
      setEditSaving(false);
      if (m.payload.success) {
        setEditMode(false);
        // Refresh skill content and skills list
        setSkillContent(null);
        setContentLoading(true);
        client.send({ type: 'skills.content', payload: { name: selectedSkill.name, source: selectedSkill.source } });
        client.send({ type: 'skills.list' });
      } else {
        setEditError(m.payload.error ?? 'Save failed');
      }
      client.off('skills.edited', handler as (msg: unknown) => void);
    };

    client.on('skills.edited', handler as (msg: unknown) => void);
    client.editSkill(selectedSkill.name, editContent);
  }, [client, selectedSkill, editContent]);

  // Uninstall the current or specified skill
  const handleUninstallSkill = useCallback(
    async (skill: SkillInfo) => {
      if (!client) return;
      setUninstalling(true);

      const handler = (msg: unknown) => {
        const m = msg as { payload: { success: boolean; error: string | null } };
        setUninstalling(false);
        if (m.payload.success) {
          setUninstallConfirmSkill(null);
          // Refresh skills list
          client.send({ type: 'skills.list' });
          // If we uninstalled the currently viewed skill, close the detail
          if (selectedSkill?.name === skill.name) {
            setSkillContent(null);
            setDetailOpen(false);
            setSelectedSkill(null);
          }
          // Remove the skill's ref from knownRefs and clear updateAvailableCount
          const currentState = skillsStateRef.current;
          const newKnownRefs = { ...currentState.knownRefs };
          delete newKnownRefs[skill.name];
          setSkillsState({
            ...currentState,
            knownRefs: newKnownRefs,
            detailOpen: selectedSkill?.name === skill.name ? false : currentState.detailOpen,
            selectedSkill: selectedSkill?.name === skill.name ? null : currentState.selectedSkill,
          });
        } else {
          setInstallError(m.payload.error ?? 'Uninstall failed');
        }
        client.off('skills.uninstalled', handler as (msg: unknown) => void);
      };

      client.on('skills.uninstalled', handler as (msg: unknown) => void);
      client.uninstallSkill(skill.name, skill.source === 'user');
    },
    [client, selectedSkill, skillsState, setSkillsState],
  );

  // Query skills on mount; restore selected skill from store if detailOpen was true
  useEffect(() => {
    if (!client) return;
    setLoading(true);

    const handleSkillsList = (msg: unknown) => {
      const m = msg as { payload: { enabled: boolean; skills: SkillInfo[]; error?: string } };
      if (m.payload.enabled && m.payload.skills) {
        setSkills(m.payload.skills);

        // Compute updateAvailableCount by comparing live refs against known refs
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

        // Sync knownRefs and updateAvailableCount to the persisted store
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: updateCount,
        });

        // Restore detail view from store ONLY when detailOpen is true (user had the detail open)
        // and we haven't already restored. This fires on first mount with persisted detail state.
        if (!didRestore.current && currentState.selectedSkill && currentState.detailOpen) {
          didRestore.current = true;
          setDetailOpen(true);
          setSelectedSkill(currentState.selectedSkill);
          setNavHistory(currentState.navHistory);
          setHistoryIndex(currentState.historyIndex);
          setContentLoading(true);
          client.send({
            type: 'skills.content',
            payload: { name: currentState.selectedSkill.name, source: currentState.selectedSkill.source },
          });
        }
      }
      setLoading(false);
    };

    const handleSkillsContent = (msg: unknown) => {
      const m = msg as { payload: { name: string; body: string; path: string; source: string; relatedFiles: string[]; references: string[]; error?: string } };
      if (!m.payload.error && m.payload.name) {
        setSkillContent(m.payload);
      }
      setContentLoading(false);
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
      const currentState = skillsStateRef.current;
      if (m.payload.success) {
        // Optimistically update knownRefs with the new refs — the next skills.list will confirm
        const newKnownRefs = { ...currentState.knownRefs };
        for (const u of m.payload.updated ?? []) {
          newKnownRefs[u.name] = u.newRef;
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: 0, // cleared — updates applied or no updates available
        });
        setUpdateResult({
          updated: m.payload.updated ?? [],
          unchanged: m.payload.unchanged ?? [],
          errors: m.payload.errors ?? [],
        });
        // Refresh the skills list to get confirmed refs from the server
        client.send({ type: 'skills.list' });
      } else {
        setUpdateResult({ updated: [], unchanged: [], errors: [{ name: '', error: m.payload.error ?? 'Update failed' }] });
      }
    };

    client.on('skills.list', handleSkillsList as (msg: unknown) => void);
    client.on('skills.content', handleSkillsContent as (msg: unknown) => void);
    client.on('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    client.send({ type: 'skills.list' });

    return () => {
      client.off('skills.list', handleSkillsList as (msg: unknown) => void);
      client.off('skills.content', handleSkillsContent as (msg: unknown) => void);
      client.off('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    };
  }, [client]);

  // Reset edit mode when navigating away from a skill
  useEffect(() => {
    if (editMode) {
      setEditMode(false);
      setEditContent('');
      setEditError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkill?.name]);

  // Find a skill by name (case-insensitive)
  const findSkillByName = useCallback((name: string): SkillInfo | undefined => {
    return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }, [skills]);

  // Sync the current navigation state to the persisted store (including detailOpen)
  const syncToStore = useCallback(
    (skill: SkillInfo, history: SkillInfo[], index: number, isDetailOpen: boolean) => {
      const currentState = skillsStateRef.current;
      setSkillsState({ ...currentState, selectedSkill: skill, navHistory: history, historyIndex: index, detailOpen: isDetailOpen });
    },
    [setSkillsState],
  );

  // Fetch skill content when selected; push to breadcrumb history when fromRelated=true
  const handleSelectSkill = useCallback(
    (skill: SkillInfo, fromRelated = false) => {
      // If re-selecting the current skill (not via related), just re-open the detail
      if (!fromRelated && selectedSkill?.name === skill.name) {
        setDetailOpen(true);
        setSkillsState({ ...skillsState, detailOpen: true });
        return;
      }

      setSelectedSkill(skill);
      setSkillContent(null);
      setContentLoading(true);
      setDetailOpen(true);
      client.send({ type: 'skills.content', payload: { name: skill.name, source: skill.source } });

      if (fromRelated && !isNavigatingBack.current) {
        const newHistory = navHistory.slice(0, historyIndex + 1);
        newHistory.push(skill);
        setNavHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
        syncToStore(skill, newHistory, newHistory.length - 1, true);
      } else if (fromRelated && isNavigatingBack.current) {
        // Navigated back, then selected a new related skill — start fresh from here
        isNavigatingBack.current = false;
      } else if (!fromRelated) {
        // Direct selection from the list — start a new breadcrumb with just this skill
        setNavHistory([skill]);
        setHistoryIndex(0);
        syncToStore(skill, [skill], 0, true);
      }
    },
    [client, historyIndex, navHistory, syncToStore],
  );

  // Navigate to a skill by name (looks up the skill info first)
  const handleNavigateToSkill = useCallback(
    (name: string) => {
      const skill = findSkillByName(name);
      if (skill) {
        handleSelectSkill(skill, true);
      }
    },
    [findSkillByName, handleSelectSkill],
  );

  // Go back one step in breadcrumb history
  const handleBreadcrumbBack = useCallback(() => {
    if (historyIndex <= 0) return;
    isNavigatingBack.current = true;
    const newIndex = historyIndex - 1;
    const skill = navHistory[newIndex];
    setHistoryIndex(newIndex);
    setSelectedSkill(skill);
    setSkillContent(null);
    setContentLoading(true);
    client.send({ type: 'skills.content', payload: { name: skill.name, source: skill.source } });
    syncToStore(skill, navHistory, newIndex, true);
  }, [historyIndex, navHistory, client, syncToStore]);

  // Go forward one step in breadcrumb history
  const handleBreadcrumbForward = useCallback(() => {
    if (historyIndex >= navHistory.length - 1) return;
    isNavigatingBack.current = true;
    const newIndex = historyIndex + 1;
    const skill = navHistory[newIndex];
    setHistoryIndex(newIndex);
    setSelectedSkill(skill);
    setSkillContent(null);
    setContentLoading(true);
    client.send({ type: 'skills.content', payload: { name: skill.name, source: skill.source } });
    syncToStore(skill, navHistory, newIndex, true);
  }, [historyIndex, navHistory, client, syncToStore]);

  // Close detail view — keep selectedSkill and breadcrumb so list stays highlighted
  const handleCloseDetail = useCallback(() => {
    setSkillContent(null);
    setDetailOpen(false);
    // Sync detailOpen=false to store but keep selectedSkill + navHistory for the list highlight
    setSkillsState({ ...skillsState, detailOpen: false });
  }, [skillsState, setSkillsState]);

  // Copy the skill's source URL to clipboard
  const handleCopySourceUrl = useCallback(() => {
    if (!selectedSkill?.sourceUrl) return;
    navigator.clipboard.writeText(selectedSkill.sourceUrl).then(() => {
      setCopiedSourceUrl(true);
      setTimeout(() => setCopiedSourceUrl(false), 2000);
    });
  }, [selectedSkill]);

  // Check for updates for the selected skill
  const handleCheckForUpdates = useCallback(() => {
    if (!client || !selectedSkill) return;
    setCheckingForUpdates(true);
    setUpdateResult(null);
    client.checkForUpdates(selectedSkill.name, selectedSkill.source === 'user');
  }, [client, selectedSkill]);

  // Refresh all installed skills
  const handleRefreshAll = useCallback(() => {
    if (!client) return;
    setCheckingForUpdates(true);
    setUpdateResult(null);
    client.checkForUpdates(undefined, undefined);
  }, [client]);

  const filteredSkills = useMemo(() => {
    let result = skills;

    if (scopeFilter !== 'all') {
      result = result.filter((s) => s.source === scopeFilter);
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
      bundled: [],
    };
    for (const skill of filteredSkills) {
      const key = skill.source || 'bundled';
      if (groups[key]) {
        groups[key].push(skill);
      } else {
        groups.bundled.push(skill);
      }
    }
    return groups;
  }, [filteredSkills]);

  return (
    <div className={cn('flex h-full overflow-hidden', className)}>
      {/* ── Skill list ── */}
      <div className="w-56 shrink-0 border-r flex flex-col overflow-hidden">
        {/* Search + filter */}
        <div className="p-2 space-y-2 border-b shrink-0">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills…"
              className="flex-1 px-2 py-1 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => {
                setInstallRef('');
                setInstallError(null);
                setInstallSuccess(null);
                setInstallGlobal(false);
                setInstallModalOpen(true);
              }}
              className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
              title="Install skill"
            >
              <Plus className="h-3 w-3" />
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
              className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
              title={
                selectedSkill
                  ? `Create similar skill (e.g. my-${selectedSkill.name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')})`
                  : 'Create skill'
              }
            >
              <FileText className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={handleRefreshAll}
              disabled={checkingForUpdates}
              className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 disabled:opacity-50 relative"
              title="Check for updates (all skills)"
            >
              {checkingForUpdates ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {/* Update available badge */}
              {!checkingForUpdates && skillsState.updateAvailableCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-primary text-[8px] font-bold text-primary-foreground flex items-center justify-center">
                  {skillsState.updateAvailableCount > 9 ? '9+' : skillsState.updateAvailableCount}
                </span>
              )}
            </button>
          </div>
          <div className="flex gap-1 flex-wrap">
            {(['all', 'project', 'user', 'bundled'] as ScopeFilter[]).map((scope) => {
              const count = scope === 'all' ? filteredSkills.length : filteredSkills.filter((s) => s.source === scope).length;
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
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading…</div>
          ) : filteredSkills.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {skills.length === 0 ? 'No skills installed' : 'No skills match filter'}
            </div>
          ) : (
            <div className="py-1">
              {(['project', 'user', 'bundled'] as const).map((scope) => {
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
                          selectedSkill?.name === skill.name
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-accent/50 text-foreground',
                        )}
                      >
                        <div className="font-medium truncate">{skill.name}</div>
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
      </div>

      {/* ── Skill detail ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {detailOpen && selectedSkill ? (
          <>
            {/* Breadcrumb navigation bar */}
            {navHistory.length > 1 && (
              <div className="px-3 py-1.5 border-b bg-muted/20 shrink-0 flex items-center gap-1">
                {/* Back button */}
                <button
                  type="button"
                  onClick={handleBreadcrumbBack}
                  disabled={historyIndex <= 0}
                  className={cn(
                    'p-1 rounded transition-colors',
                    historyIndex <= 0
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : 'hover:bg-accent text-muted-foreground cursor-pointer',
                  )}
                  title="Go back"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>

                {/* Forward button */}
                <button
                  type="button"
                  onClick={handleBreadcrumbForward}
                  disabled={historyIndex >= navHistory.length - 1}
                  className={cn(
                    'p-1 rounded transition-colors mr-1',
                    historyIndex >= navHistory.length - 1
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : 'hover:bg-accent text-muted-foreground cursor-pointer',
                  )}
                  title="Go forward"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>

                {/* Breadcrumb trail */}
                <div className="flex items-center gap-0.5 overflow-x-auto text-[11px]">
                  {navHistory.map((skill, idx) => {
                    const isCurrent = idx === historyIndex;
                    const isPast = idx < historyIndex;
                    return (
                      <span key={skill.name + idx} className="flex items-center shrink-0">
                        {idx > 0 && (
                          <ChevronRight className="h-3 w-3 text-muted-foreground/40 mx-0.5 shrink-0" />
                        )}
                        {isPast ? (
                          // Past items are clickable
                          <button
                            type="button"
                            onClick={() => {
                              isNavigatingBack.current = true;
                              setHistoryIndex(idx);
                              setSelectedSkill(skill);
                              setSkillContent(null);
                              setContentLoading(true);
                              setDetailOpen(true);
                              client.send({ type: 'skills.content', payload: { name: skill.name, source: skill.source } });
                            }}
                            className="hover:text-primary text-muted-foreground cursor-pointer transition-colors"
                          >
                            {skill.name}
                          </button>
                        ) : (
                          <span className={cn('font-medium', isCurrent ? 'text-primary' : 'text-foreground')}>
                            {skill.name}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Detail header */}
            <div className="px-4 py-3 border-b shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary shrink-0" />
                    <h2 className="text-sm font-semibold truncate">{selectedSkill.name}</h2>
                    {selectedSkill.version && (
                      <span className="text-[10px] text-muted-foreground">v{selectedSkill.version}</span>
                    )}
                    <ScopeBadge source={selectedSkill.source} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                    {selectedSkill.description || selectedSkill.trigger}
                  </p>
                  {/* Source URL */}
                  {selectedSkill.sourceUrl && (
                    <div className="flex items-center gap-1 mt-1">
                      <a
                        href={`https://${selectedSkill.sourceUrl.replace('github:', '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        title="Open source repo"
                      >
                        <Globe className="h-3 w-3 shrink-0" />
                        <span className="text-[10px] truncate font-mono">
                          {selectedSkill.sourceUrl}
                        </span>
                      </a>
                      <button
                        type="button"
                        onClick={handleCopySourceUrl}
                        className="flex items-center shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        title="Copy source URL"
                      >
                        {copiedSourceUrl ? (
                          <Check className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  )}

                  {/* Update result */}
                  {updateResult && (
                    <div className="mt-2 text-[10px] space-y-1">
                      {updateResult.updated.length > 0 && (
                        <div className="text-green-600">
                          ↑ Updated: {updateResult.updated.map((u) => `${u.name} (${u.oldRef} → ${u.newRef})`).join(', ')}
                        </div>
                      )}
                      {updateResult.unchanged.length > 0 && (
                        <div className="text-muted-foreground">
                          — Up to date: {updateResult.unchanged.join(', ')}
                        </div>
                      )}
                      {updateResult.errors.length > 0 && (
                        <div className="text-destructive">
                          ✗ {updateResult.errors.map((e) => `${e.name ? `${e.name}: ` : ''}${e.error}`).join('; ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  {/* Check for updates — only for installed skills with a source URL */}
                  {selectedSkill.source !== 'bundled' && selectedSkill.sourceUrl && (
                    <button
                      type="button"
                      onClick={handleCheckForUpdates}
                      disabled={checkingForUpdates}
                      className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
                      title="Check for updates"
                    >
                      {checkingForUpdates ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  {/* Uninstall button — only for project/user scope, not bundled */}
                  {selectedSkill.source !== 'bundled' && (
                    <button
                      type="button"
                      onClick={() => setUninstallConfirmSkill(selectedSkill)}
                      className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                      title="Uninstall skill"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* Edit button — only for project/user scope, not bundled */}
                  {selectedSkill.source !== 'bundled' && !editMode && (
                    <button
                      type="button"
                      onClick={handleStartEdit}
                      className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                      title="Edit skill"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleCloseDetail}
                    className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Trigger keywords */}
              {selectedSkill.scope.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedSkill.scope.map((s) => (
                    <span
                      key={s}
                      className="px-1.5 py-0.5 text-[9px] rounded bg-muted text-muted-foreground"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Related files + References */}
            {skillContent && (skillContent.relatedFiles.length > 0 || skillContent.references.length > 0) && (
              <div className="px-4 py-2 border-b bg-muted/30 shrink-0 space-y-2">
                {/* Related files */}
                {skillContent.relatedFiles.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
                      <FolderOpen className="h-3 w-3" />
                      <span className="font-medium uppercase tracking-wide">Related Files</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {skillContent.relatedFiles.map((file) => {
                        // Try to derive a skill name and check if it's a known skill
                        const derivedName = skillNameFromFile(file);
                        const linkedSkill = derivedName ? findSkillByName(derivedName) : undefined;
                        const isNavigable = !!linkedSkill;

                        return isNavigable ? (
                          <button
                            key={file}
                            type="button"
                            onClick={() => handleNavigateToSkill(derivedName!)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-background border border-border hover:border-primary hover:text-primary transition-colors cursor-pointer"
                            title={`Go to ${derivedName}`}
                          >
                            <ArrowUpRight className="h-2.5 w-2.5" />
                            {file}
                          </button>
                        ) : (
                          <span
                            key={file}
                            className="px-1.5 py-0.5 text-[10px] rounded bg-background border border-border text-muted-foreground"
                          >
                            {file}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* References */}
                {skillContent.references.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
                      <FileText className="h-3 w-3" />
                      <span className="font-medium uppercase tracking-wide">References</span>
                      <span className="text-[9px] opacity-60">skills that mention this</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {skillContent.references.map((ref) => {
                        // ref is a filename like "api-design/SKILL.save.md" or just the skill name
                        const derivedName = skillNameFromFile(ref) ?? ref.replace(/\.md$/, '');
                        const linkedSkill = findSkillByName(derivedName);
                        const isNavigable = !!linkedSkill;

                        return isNavigable ? (
                          <button
                            key={ref}
                            type="button"
                            onClick={() => handleNavigateToSkill(derivedName)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-primary/5 border border-primary/20 text-primary hover:bg-primary/10 hover:border-primary/30 transition-colors cursor-pointer"
                            title={`Go to ${derivedName}`}
                          >
                            <ArrowUpRight className="h-2.5 w-2.5" />
                            {derivedName}
                          </button>
                        ) : (
                          <span
                            key={ref}
                            className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground"
                          >
                            {derivedName}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {contentLoading ? (
                <div className="p-4 text-xs text-muted-foreground text-center">Loading content…</div>
              ) : editMode ? (
                <div className="flex flex-col h-full">
                  {/* Edit toolbar */}
                  <div className="px-4 py-2 border-b shrink-0 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-muted-foreground">
                        Editing <span className="font-medium text-foreground">{selectedSkill.name}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {editStats.lines.toLocaleString()} line{editStats.lines !== 1 ? 's' : ''} · {editStats.words.toLocaleString()} word{editStats.words !== 1 ? 's' : ''} · {editStats.chars.toLocaleString()} char{editStats.chars !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {editError && (
                        <span className="text-[10px] text-destructive">{editError}</span>
                      )}
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="px-2 py-1 text-[10px] rounded border border-border hover:bg-accent transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => setSplitPreview((v) => !v)}
                        title={splitPreview ? 'Hide preview' : 'Split view'}
                        className={`px-2 py-1 text-[10px] rounded border transition-colors cursor-pointer ${
                          splitPreview
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border hover:bg-accent text-muted-foreground'
                        }`}
                      >
                        <PanelRight className="h-3 w-3 inline" />
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        disabled={editSaving || !editContent.trim()}
                        className="px-2 py-1 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {editSaving ? <Loader2 className="h-3 w-3 animate-spin inline" /> : 'Save'}
                      </button>
                    </div>
                  </div>
                  {/* Edit textarea — split view or editor-only */}
                  {splitPreview ? (
                    <div className="flex flex-1 min-h-0 gap-0.5">
                      {/* Left: editor */}
                      <div className="flex-1 min-w-0 flex flex-col min-h-0">
                        <TextareaCodeEditor
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value ?? '')}
                          language="markdown"
                          className="flex-1"
                          style={{
                            fontSize: 12,
                            backgroundColor: 'transparent',
                            minHeight: 0,
                          }}
                          placeholder="Skill content (markdown)..."
                        />
                      </div>
                      {/* Divider */}
                      <div className="w-px bg-border flex-shrink-0" />
                      {/* Right: live preview */}
                      <div className="flex-1 min-w-0 overflow-y-auto p-4 prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                          {editContent}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : (
                    <TextareaCodeEditor
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value ?? '')}
                      language="markdown"
                      className="flex-1"
                      style={{
                        fontSize: 12,
                        backgroundColor: 'transparent',
                        minHeight: 0,
                      }}
                      placeholder="Skill content (markdown)..."
                    />
                  )}
                </div>
              ) : skillContent ? (
                <div className="p-4 prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown
                    rehypePlugins={[rehypeHighlight]}
                    components={markdownComponents}
                  >
                    {skillContent.body}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="p-4 text-xs text-muted-foreground text-center">
                  Failed to load skill content
                </div>
              )}
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
            <BookOpen className="h-10 w-10 mb-3 opacity-20" />
            <p className="text-sm font-medium">Select a skill</p>
            <p className="text-xs mt-1 text-center max-w-[200px]">
              Choose a skill from the list to view its documentation and details
            </p>
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
          <div className="bg-background rounded-lg border shadow-xl w-[420px] max-w-[90vw]">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">Install Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setInstallModalOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
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
                <span className="text-[10px] text-muted-foreground">
                  {installGlobal ? '~/.wrongstack/skills' : '.wrongstack/skills'}
                </span>
              </div>

              {installError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{installError}</p>
              )}
              {installSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded px-2 py-1">{installSuccess}</p>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t bg-muted/20">
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

      {/* ── Uninstall confirmation modal ── */}
      {uninstallConfirmSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setUninstallConfirmSkill(null);
          }}
        >
          <div className="bg-background rounded-lg border shadow-xl w-[380px] max-w-[90vw]">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-destructive" />
                <span className="font-semibold text-sm">Uninstall Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setUninstallConfirmSkill(null)}
                className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-2">
              <p className="text-sm">
                Uninstall <span className="font-semibold">{uninstallConfirmSkill.name}</span>?
              </p>
              <p className="text-xs text-muted-foreground">
                This will remove the skill from{' '}
                <span className="font-mono text-[10px]">
                  {uninstallConfirmSkill.source === 'user' ? '~/.wrongstack/skills' : '.wrongstack/skills'}
                </span>{' '}
                and cannot be undone.
              </p>
              {installError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{installError}</p>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t bg-muted/20">
              <button
                type="button"
                onClick={() => setUninstallConfirmSkill(null)}
                disabled={uninstalling}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleUninstallSkill(uninstallConfirmSkill)}
                disabled={uninstalling}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {uninstalling && <Loader2 className="h-3 w-3 animate-spin" />}
                Uninstall
              </button>
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
          <div className="bg-background rounded-lg border shadow-xl w-[480px] max-w-[90vw]">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">Create Skill</span>
              </div>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
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
                <p className="text-[10px] text-muted-foreground mt-1">
                  The first line is the trigger. Optional: add a blank line then more description, then a "Triggers:" line.
                </p>
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
                <span className="text-[10px] text-muted-foreground">
                  {createScope === 'global' ? '~/.wrongstack/skills' : '.wrongstack/skills'}
                </span>
              </div>

              {createError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{createError}</p>
              )}
              {createSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded px-2 py-1">{createSuccess}</p>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t bg-muted/20">
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