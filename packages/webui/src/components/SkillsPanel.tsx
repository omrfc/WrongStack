/**
 * SkillsPanel — displays installed skills with markdown rendering.
 *
 * Shows skills organized by scope (project, user, bundled), with a markdown
 * view that displays the skill content plus references, scripts, and related files.
 */

import { Sparkles, FileText, FolderOpen, X, ChevronRight, BookOpen, ArrowUpRight, ChevronLeft, Plus, Trash2, Download, Loader2 } from 'lucide-react';
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
            setSkillsState({ ...skillsState, selectedSkill: null, detailOpen: false });
          }
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

        // Restore detail view from store ONLY when detailOpen is true (user had the detail open)
        // and we haven't already restored. This fires on first mount with persisted detail state.
        if (!didRestore.current && skillsState.selectedSkill && skillsState.detailOpen) {
          didRestore.current = true;
          setDetailOpen(true);
          setSelectedSkill(skillsState.selectedSkill);
          setNavHistory(skillsState.navHistory);
          setHistoryIndex(skillsState.historyIndex);
          setContentLoading(true);
          client.send({
            type: 'skills.content',
            payload: { name: skillsState.selectedSkill.name, source: skillsState.selectedSkill.source },
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

    client.on('skills.list', handleSkillsList as (msg: unknown) => void);
    client.on('skills.content', handleSkillsContent as (msg: unknown) => void);
    client.send({ type: 'skills.list' });

    return () => {
      client.off('skills.list', handleSkillsList as (msg: unknown) => void);
      client.off('skills.content', handleSkillsContent as (msg: unknown) => void);
    };
  }, [client]);

  // Find a skill by name (case-insensitive)
  const findSkillByName = useCallback((name: string): SkillInfo | undefined => {
    return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }, [skills]);

  // Sync the current navigation state to the persisted store (including detailOpen)
  const syncToStore = useCallback(
    (skill: SkillInfo, history: SkillInfo[], index: number, isDetailOpen: boolean) => {
      setSkillsState({ selectedSkill: skill, navHistory: history, historyIndex: index, detailOpen: isDetailOpen });
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
          </div>
          <div className="flex gap-1 flex-wrap">
            {(['all', 'project', 'user', 'bundled'] as ScopeFilter[]).map((scope) => {
              const count = scope === 'all' ? skills.length : skills.filter((s) => s.source === scope).length;
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
                  <span className={cn('ml-1', scopeFilter === scope ? 'opacity-80' : 'opacity-50')}>{count}</span>
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
                </div>
                <div className="flex items-center gap-1 ml-auto">
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
    </div>
  );
}
