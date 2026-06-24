/**
 * SkillDetailView — displays the selected skill's content in the main content area.
 * Shown when currentView === 'skill'.
 */

import {
  Sparkles,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  Globe,
  ArrowUpRight,
  FolderOpen,
  FileText,
  Loader2,
  PanelRight,
  BookOpen,
} from 'lucide-react';
import TextareaCodeEditor from '@uiw/react-textarea-code-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { markdownComponents } from './MessageBubble/utils';

interface SkillContent {
  name: string;
  body: string;
  path: string;
  source: string;
  relatedFiles: string[];
  references: string[];
}

/** Derive a skill name from a related filename like "api-design/SKILL.save.md" → "api-design" */
function skillNameFromFile(fileName: string): string | null {
  const match = fileName.match(/^(.+?)\/SKILL(?:\.save)?\.md$/);
  return match ? match[1] : null;
}

function ScopeBadge({ source }: { source: string }) {
  const scope = source === 'project' ? 'project' : source === 'user' ? 'user' : 'bundled';
  const labels: Record<string, string> = { project: 'Project', user: 'Global', bundled: 'Bundled' };

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
        scope === 'project' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
        scope === 'user' && 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400',
        scope === 'bundled' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
      )}
    >
      {labels[scope]}
    </span>
  );
}

export function SkillDetailView({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const skillsState = useUIStore((s) => s.skillsState);
  const setSkillsState = useUIStore((s) => s.setSkillsState);
  const setCurrentView = useUIStore((s) => s.setCurrentView);

  const selectedSkill = skillsState.selectedSkill;
  const navHistory = skillsState.navHistory;
  const historyIndex = skillsState.historyIndex;

  const [skillContent, setSkillContent] = useState<SkillContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [splitPreview, setSplitPreview] = useState(false);

  // Draft state
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const lastSavedDraftRef = useRef<string>('');

  // Update check state
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    updated: Array<{ name: string; oldRef: string; newRef: string }>;
    unchanged: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);

  // Copy source URL feedback
  const [copiedSourceUrl, setCopiedSourceUrl] = useState(false);

  // Uninstall state
  const [uninstallConfirmSkill, setUninstallConfirmSkill] = useState<typeof selectedSkill>(null);
  const [uninstalling, setUninstalling] = useState(false);

  // Skills list (for finding related skills)
  const [skills, setSkills] = useState<Array<{ name: string; description: string; version: string; source: string; sourceUrl: string; ref: string; path: string; trigger: string; scope: string[] }>>([]);
  const skillsStateRef = useRef(skillsState);
  skillsStateRef.current = skillsState;

  const isNavigatingBack = useRef(false);

  // Edit stats
  const editStats = useMemo(() => {
    if (!editContent) return { lines: 0, words: 0, chars: 0 };
    const lines = editContent.split('\n').length;
    const words = editContent.trim() ? editContent.trim().split(/\s+/).length : 0;
    const chars = editContent.length;
    return { lines, words, chars };
  }, [editContent]);

  // localStorage warning
  const charsWarning = useMemo((): null | { level: 'warn' | 'critical'; used: number; limit: number } => {
    if (!editContent) return null;
    const LOCALSTORAGE_LIMIT = 5 * 1024 * 1024;
    const SOFT_LIMIT = 4 * 1024 * 1024;
    const sizeBytes = new Blob([editContent]).size;
    if (sizeBytes >= LOCALSTORAGE_LIMIT) return { level: 'critical', used: sizeBytes, limit: LOCALSTORAGE_LIMIT };
    if (sizeBytes >= SOFT_LIMIT) return { level: 'warn', used: sizeBytes, limit: LOCALSTORAGE_LIMIT };
    return null;
  }, [editContent]);

  // Clear draftSavedAt after 2 seconds
  useEffect(() => {
    if (!draftSavedAt) return;
    const t = setTimeout(() => setDraftSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [draftSavedAt]);

  // Auto-save draft to localStorage every 5 seconds while editing
  useEffect(() => {
    if (!editMode || !selectedSkill) return;
    const interval = setInterval(() => {
      if (editContent && editContent !== lastSavedDraftRef.current) {
        lastSavedDraftRef.current = editContent;
        localStorage.setItem(
          `skills_draft_${selectedSkill.name}`,
          JSON.stringify({ content: editContent, savedAt: Date.now() }),
        );
        setDraftSavedAt(Date.now());
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [editMode, editContent, selectedSkill]);

  // Restore draft from localStorage
  useEffect(() => {
    if (!selectedSkill || !editMode) return;
    const raw = localStorage.getItem(`skills_draft_${selectedSkill.name}`);
    if (raw) {
      try {
        const { content } = JSON.parse(raw) as { content: string; savedAt: number };
        if (content && content !== editContent && content !== lastSavedDraftRef.current) {
          setEditContent(content);
          lastSavedDraftRef.current = content;
          setDraftRestored(true);
        }
      } catch {
        // ignore malformed draft
      }
    }
  }, [selectedSkill?.name, editMode]);

  // Fetch skill content when selected skill changes
  useEffect(() => {
    if (!client || !selectedSkill) return;
    setContentLoading(true);
    setSkillContent(null);
    setContentError(null);

    // Timeout after 10 seconds
    const timeoutId = setTimeout(() => {
      setContentLoading(false);
      setContentError('Request timed out. Please try again.');
    }, 10000);

    const handleSkillsContent = (msg: unknown) => {
      clearTimeout(timeoutId);
      const m = msg as { payload: { name: string; body: string; path: string; source: string; relatedFiles: string[]; references: string[]; error?: string } };
      if (m.payload.error) {
        setContentError(m.payload.error);
      } else if (m.payload.name) {
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
        const newKnownRefs = { ...currentState.knownRefs };
        for (const u of m.payload.updated ?? []) {
          newKnownRefs[u.name] = u.newRef;
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: 0,
        });
        setUpdateResult({
          updated: m.payload.updated ?? [],
          unchanged: m.payload.unchanged ?? [],
          errors: m.payload.errors ?? [],
        });
        client.send({ type: 'skills.list' });
      } else {
        setUpdateResult({ updated: [], unchanged: [], errors: [{ name: '', error: m.payload.error ?? 'Update failed' }] });
      }
    };

    const handleSkillsList = (msg: unknown) => {
      const m = msg as { payload: { enabled: boolean; skills: typeof skills } };
      if (m.payload.skills) setSkills(m.payload.skills);
    };

    client.on('skills.content', handleSkillsContent as (msg: unknown) => void);
    client.on('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    client.on('skills.list', handleSkillsList as (msg: unknown) => void);
    client.send({ type: 'skills.content', payload: { name: selectedSkill.name, source: selectedSkill.source } });

    return () => {
      clearTimeout(timeoutId);
      client.off('skills.content', handleSkillsContent as (msg: unknown) => void);
      client.off('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
      client.off('skills.list', handleSkillsList as (msg: unknown) => void);
    };
  }, [client, selectedSkill?.name, selectedSkill?.source]);

  // Reset edit mode when navigating away
  useEffect(() => {
    if (editMode) {
      setEditMode(false);
      setEditContent('');
      setEditError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkill?.name]);

  // Find a skill by name (case-insensitive)
  const findSkillByName = useCallback(
    (name: string) => skills.find((s) => s.name.toLowerCase() === name.toLowerCase()),
    [skills],
  );

  // Navigate to a skill by name
  const handleNavigateToSkill = useCallback(
    (name: string) => {
      const skill = findSkillByName(name);
      if (skill) {
        isNavigatingBack.current = false;
        const newHistory = navHistory.slice(0, historyIndex + 1);
        newHistory.push(skill);
        setSkillsState({
          ...skillsStateRef.current,
          selectedSkill: skill,
          navHistory: newHistory,
          historyIndex: newHistory.length - 1,
        });
        setEditMode(false);
        setEditContent('');
        setUpdateResult(null);
      }
    },
    [findSkillByName, navHistory, historyIndex, setSkillsState],
  );

  // Breadcrumb navigation
  const handleBreadcrumbBack = useCallback(() => {
    if (historyIndex <= 0) return;
    isNavigatingBack.current = true;
    const newIndex = historyIndex - 1;
    const skill = navHistory[newIndex];
    setSkillsState({
      ...skillsStateRef.current,
      selectedSkill: skill,
      historyIndex: newIndex,
    });
    setEditMode(false);
    setEditContent('');
    setUpdateResult(null);
  }, [historyIndex, navHistory, setSkillsState]);

  const handleBreadcrumbForward = useCallback(() => {
    if (historyIndex >= navHistory.length - 1) return;
    isNavigatingBack.current = true;
    const newIndex = historyIndex + 1;
    const skill = navHistory[newIndex];
    setSkillsState({
      ...skillsStateRef.current,
      selectedSkill: skill,
      historyIndex: newIndex,
    });
    setEditMode(false);
    setEditContent('');
    setUpdateResult(null);
  }, [historyIndex, navHistory, setSkillsState]);

  // Close detail and go back to chat
  const handleClose = useCallback(() => {
    setCurrentView('chat');
  }, [setCurrentView]);

  // Start editing
  const handleStartEdit = useCallback(() => {
    if (!skillContent) return;
    setEditContent(skillContent.body);
    lastSavedDraftRef.current = skillContent.body;
    setDraftRestored(false);
    setEditError(null);
    setEditMode(true);
    setSplitPreview(false);
  }, [skillContent]);

  // Cancel editing
  const handleCancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
    setEditError(null);
    setSplitPreview(false);
    setDraftRestored(false);
    if (selectedSkill) localStorage.removeItem(`skills_draft_${selectedSkill.name}`);
  }, [selectedSkill]);

  // Discard draft
  const handleDiscardDraft = useCallback(() => {
    if (!selectedSkill || !skillContent) return;
    setDraftRestored(false);
    setEditContent(skillContent.body);
    lastSavedDraftRef.current = skillContent.body;
    if (selectedSkill) localStorage.removeItem(`skills_draft_${selectedSkill.name}`);
  }, [selectedSkill, skillContent]);

  // Save edited content
  const handleSaveEdit = useCallback(() => {
    if (!client || !selectedSkill || !editContent.trim()) return;
    setEditSaving(true);
    setEditError(null);

    const handler = (msg: unknown) => {
      const m = msg as { payload: { success: boolean; error: string | null } };
      setEditSaving(false);
      if (m.payload.success) {
        lastSavedDraftRef.current = '';
        localStorage.removeItem(`skills_draft_${selectedSkill.name}`);
        setDraftRestored(false);
        setEditMode(false);
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

  // Check for updates
  const handleCheckForUpdates = useCallback(() => {
    if (!client || !selectedSkill) return;
    setCheckingForUpdates(true);
    setUpdateResult(null);
    client.checkForUpdates(selectedSkill.name, selectedSkill.source === 'user');
  }, [client, selectedSkill]);

  // Copy source URL
  const handleCopySourceUrl = useCallback(() => {
    if (!selectedSkill?.sourceUrl) return;
    navigator.clipboard.writeText(selectedSkill.sourceUrl).then(() => {
      setCopiedSourceUrl(true);
      setTimeout(() => setCopiedSourceUrl(false), 2000);
    });
  }, [selectedSkill]);

  // Export single skill
  const handleExportSkill = useCallback(() => {
    if (!skillContent?.body) return;
    const blob = new Blob([skillContent.body], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${skillContent.name.replace(/\//g, '_')}-SKILL.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [skillContent]);

  // Uninstall skill
  const handleUninstallSkill = useCallback(
    async (skill: typeof selectedSkill) => {
      if (!client || !skill) return;
      setUninstalling(true);

      const handler = (msg: unknown) => {
        const m = msg as { payload: { success: boolean; error: string | null } };
        setUninstalling(false);
        if (m.payload.success) {
          setUninstallConfirmSkill(null);
          client.send({ type: 'skills.list' });
          handleClose();
        } else {
          setEditError(m.payload.error ?? 'Uninstall failed');
        }
        client.off('skills.uninstalled', handler as (msg: unknown) => void);
      };

      client.on('skills.uninstalled', handler as (msg: unknown) => void);
      client.uninstallSkill(skill.name, skill.source === 'user');
    },
    [client, handleClose],
  );

  if (!selectedSkill) {
    return (
      <div className={cn('flex-1 flex flex-col items-center justify-center text-muted-foreground p-8', className)}>
        <BookOpen className="h-12 w-12 mb-4 opacity-20" />
        <p className="text-base font-medium">No skill selected</p>
        <p className="text-sm mt-1 text-center max-w-[300px]">
          Select a skill from the sidebar to view its documentation
        </p>
        <button
          type="button"
          onClick={handleClose}
          className="mt-4 px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
        >
          Go to chat
        </button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full overflow-hidden bg-background', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary shrink-0" />
              <h1 className="text-base font-semibold truncate">{selectedSkill.name}</h1>
              {selectedSkill.version && (
                <span className="text-xs text-muted-foreground">v{selectedSkill.version}</span>
              )}
              <ScopeBadge source={selectedSkill.source} />
            </div>
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {selectedSkill.description || selectedSkill.trigger}
            </p>

            {/* Source URL */}
            {selectedSkill.sourceUrl && (
              <div className="flex items-center gap-1 mt-2">
                <a
                  href={`https://${selectedSkill.sourceUrl.replace('github:', '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  title="Open source repo"
                >
                  <Globe className="h-3 w-3 shrink-0" />
                  <span className="truncate font-mono">{selectedSkill.sourceUrl}</span>
                </a>
                <button
                  type="button"
                  onClick={handleCopySourceUrl}
                  className="flex items-center shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  title="Copy source URL"
                >
                  {copiedSourceUrl ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            )}

            {/* Trigger keywords */}
            {selectedSkill.scope.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {selectedSkill.scope.map((s) => (
                  <span key={s} className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
                    {s}
                  </span>
                ))}
              </div>
            )}

            {/* Update result */}
            {updateResult && (
              <div className="mt-2 text-xs space-y-1">
                {updateResult.updated.length > 0 && (
                  <div className="text-green-600">
                    ↑ Updated: {updateResult.updated.map((u) => `${u.name} (${u.oldRef} → ${u.newRef})`).join(', ')}
                  </div>
                )}
                {updateResult.unchanged.length > 0 && (
                  <div className="text-muted-foreground">— Up to date: {updateResult.unchanged.join(', ')}</div>
                )}
                {updateResult.errors.length > 0 && (
                  <div className="text-destructive">
                    ✗ {updateResult.errors.map((e) => `${e.name ? `${e.name}: ` : ''}${e.error}`).join('; ')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 ml-auto shrink-0">
            {/* Check for updates */}
            {selectedSkill.source !== 'bundled' && selectedSkill.sourceUrl && (
              <button
                type="button"
                onClick={handleCheckForUpdates}
                disabled={checkingForUpdates}
                className="flex items-center gap-1 px-2 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
                title="Check for updates"
              >
                {checkingForUpdates ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
            )}

            {/* Export + Edit */}
            {selectedSkill.source !== 'bundled' && !editMode && (
              <>
                <button
                  type="button"
                  onClick={handleExportSkill}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                  title="Export skill as .md"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                  title="Edit skill"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            {/* Uninstall */}
            {selectedSkill.source !== 'bundled' && (
              <button
                type="button"
                onClick={() => setUninstallConfirmSkill(selectedSkill)}
                className="flex items-center gap-1 px-2 py-1.5 text-xs rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                title="Uninstall skill"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Close */}
            <button
              type="button"
              onClick={handleClose}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground cursor-pointer"
              title="Close and go to chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Breadcrumb navigation */}
        {navHistory.length > 1 && (
          <div className="flex items-center gap-1 mt-2">
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
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleBreadcrumbForward}
              disabled={historyIndex >= navHistory.length - 1}
              className={cn(
                'p-1 rounded transition-colors',
                historyIndex >= navHistory.length - 1
                  ? 'text-muted-foreground/40 cursor-not-allowed'
                  : 'hover:bg-accent text-muted-foreground cursor-pointer',
              )}
              title="Go forward"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-0.5 overflow-x-auto text-xs">
              {navHistory.map((skill, idx) => (
                <span key={skill.name + idx} className="flex items-center shrink-0">
                  {idx > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40 mx-0.5 shrink-0" />}
                  <button
                    type="button"
                    onClick={() => {
                      if (idx < historyIndex) {
                        isNavigatingBack.current = true;
                        setSkillsState({
                          ...skillsStateRef.current,
                          selectedSkill: skill,
                          historyIndex: idx,
                        });
                        setEditMode(false);
                        setEditContent('');
                        setUpdateResult(null);
                      }
                    }}
                    className={cn(
                      'hover:text-primary cursor-pointer transition-colors',
                      idx === historyIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {skill.name}
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Related files + References bar */}
      {skillContent && (skillContent.relatedFiles.length > 0 || skillContent.references.length > 0) && (
        <div className="px-4 py-2 border-b bg-muted/30 shrink-0 space-y-2">
          {skillContent.relatedFiles.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <FolderOpen className="h-3 w-3" />
                <span className="font-medium uppercase tracking-wide">Related Files</span>
              </div>
              {skillContent.relatedFiles.map((file) => {
                const derivedName = skillNameFromFile(file);
                const linkedSkill = derivedName ? findSkillByName(derivedName) : undefined;
                return linkedSkill ? (
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
                  <span key={file} className="px-1.5 py-0.5 text-[10px] rounded bg-background border border-border text-muted-foreground">
                    {file}
                  </span>
                );
              })}
            </div>
          )}

          {skillContent.references.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <FileText className="h-3 w-3" />
                <span className="font-medium uppercase tracking-wide">References</span>
              </div>
              {skillContent.references.map((ref) => {
                const derivedName = skillNameFromFile(ref) ?? ref.replace(/\.md$/, '');
                const linkedSkill = findSkillByName(derivedName);
                return linkedSkill ? (
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
                  <span key={ref} className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
                    {derivedName}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {contentLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
            <p>Loading skill content…</p>
          </div>
        ) : editMode ? (
          <div className="flex flex-col h-full">
            {/* Edit toolbar */}
            <div className="px-4 py-2 border-b shrink-0 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  Editing <span className="font-medium text-foreground">{selectedSkill.name}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {editStats.lines} line{editStats.lines !== 1 ? 's' : ''} · {editStats.words} word{editStats.words !== 1 ? 's' : ''} · {editStats.chars} char{editStats.chars !== 1 ? 's' : ''}
                </span>
                {charsWarning && (
                  <span
                    className={`text-xs tabular-nums ${
                      charsWarning.level === 'critical' ? 'text-red-500 font-medium' : 'text-amber-500'
                    }`}
                  >
                    ⚠ {(charsWarning.used / (1024 * 1024)).toFixed(1)}&nbsp;MB / {(charsWarning.limit / (1024 * 1024)).toFixed(0)}&nbsp;MB
                  </span>
                )}
                {draftSavedAt && <span className="text-xs text-green-500 animate-pulse">Draft saved</span>}
                {draftRestored && <span className="text-xs text-amber-500 animate-pulse">Draft restored</span>}
              </div>
              <div className="flex items-center gap-2">
                {editError && <span className="text-xs text-destructive">{editError}</span>}
                {draftRestored && (
                  <button
                    type="button"
                    onClick={handleDiscardDraft}
                    className="px-2 py-1 text-[10px] rounded border border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer"
                  >
                    Discard draft
                  </button>
                )}
                <button type="button" onClick={handleCancelEdit} className="px-2 py-1 text-xs rounded border border-border hover:bg-accent transition-colors cursor-pointer">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setSplitPreview((v) => !v)}
                  title={splitPreview ? 'Hide preview' : 'Split view'}
                  className={`px-2 py-1 text-xs rounded border transition-colors cursor-pointer ${
                    splitPreview ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent text-muted-foreground'
                  }`}
                >
                  <PanelRight className="h-3 w-3 inline" />
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editSaving || !editContent.trim()}
                  className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {editSaving ? <Loader2 className="h-3 w-3 animate-spin inline" /> : 'Save'}
                </button>
              </div>
            </div>

            {/* Edit textarea */}
            {splitPreview ? (
              <div className="flex flex-1 min-h-0 gap-0.5">
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                  <TextareaCodeEditor
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value ?? '')}
                    language="markdown"
                    className="flex-1"
                    style={{ fontSize: 12, backgroundColor: 'transparent', minHeight: 0 }}
                    placeholder="Skill content (markdown)..."
                  />
                </div>
                <div className="w-px bg-border flex-shrink-0" />
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
                style={{ fontSize: 12, backgroundColor: 'transparent', minHeight: 0 }}
                placeholder="Skill content (markdown)..."
              />
            )}
          </div>
        ) : skillContent ? (
          <div className="p-6 prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
              {skillContent.body}
            </ReactMarkdown>
          </div>
        ) : contentError ? (
          <div className="p-8 text-center">
            <p className="text-destructive mb-2">Failed to load skill content</p>
            <p className="text-xs text-muted-foreground">{contentError}</p>
            <button
              type="button"
              onClick={() => {
                if (client && selectedSkill) {
                  setContentLoading(true);
                  setContentError(null);
                  client.send({ type: 'skills.content', payload: { name: selectedSkill.name, source: selectedSkill.source } });
                }
              }}
              className="mt-4 px-3 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            No skill content available
          </div>
        )}
      </div>

      {/* Uninstall confirmation modal */}
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
              <button type="button" onClick={() => setUninstallConfirmSkill(null)} className="p-1 rounded hover:bg-accent text-muted-foreground cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-2">
              <p className="text-sm">Uninstall <span className="font-semibold">{uninstallConfirmSkill.name}</span>?</p>
              <p className="text-xs text-muted-foreground">
                This will remove the skill from{' '}
                <span className="font-mono text-[10px]">
                  {uninstallConfirmSkill.source === 'user' ? '~/.wrongstack/skills' : '.wrongstack/skills'}
                </span>{' '}
                and cannot be undone.
              </p>
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
    </div>
  );
}