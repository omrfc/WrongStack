import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '@/stores';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Check, Edit3, Globe, X } from 'lucide-react';

export type RefineDecision = 'refined' | 'english' | 'original' | 'edit';

interface RefinePanelProps {
  original: string;
  refined: string;
  english: string;
  onDecision: (decision: RefineDecision) => void;
  /** Auto-send countdown in ms. Default 0 (no auto-send). */
  autoSendDelayMs?: number;
}

/**
 * Prompt-refinement preview ("did you mean this?").
 * Shows the refined request in both original language and English,
 * plus the original. User picks one or edits.
 *
 * Keyboard shortcuts:
 * - Enter → send refined (original language)
 * - e → send English version
 * - o → send original
 * - t → edit the refined version
 * - Esc → cancel and send original
 */
export function RefinePanel({
  original,
  refined,
  english,
  onDecision,
  autoSendDelayMs = 0,
}: RefinePanelProps) {
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const [countdown, setCountdown] = useState(autoSendDelayMs > 0 ? Math.ceil(autoSendDelayMs / 1000) : null);
  const [editText, setEditText] = useState(refined);
  const [isEditing, setIsEditing] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-send countdown
  useEffect(() => {
    if (autoSendDelayMs <= 0 || isEditing) return;

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownRef.current!);
          onDecision('refined');
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoSendDelayMs, isEditing, onDecision]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't steal keys from inputs outside the panel
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'Enter':
          if (!isEditing) {
            e.preventDefault();
            onDecision('refined');
          }
          break;
        case 'e':
        case 'E':
          if (!isEditing) {
            e.preventDefault();
            onDecision('english');
          }
          break;
        case 'o':
        case 'O':
          if (!isEditing) {
            e.preventDefault();
            onDecision('original');
          }
          break;
        case 't':
        case 'T':
          if (!isEditing) {
            e.preventDefault();
            setIsEditing(true);
          }
          break;
        case 'Escape':
          e.preventDefault();
          if (isEditing) {
            setIsEditing(false);
            setEditText(refined);
          } else {
            setRefinePanel(null);
            onDecision('original');
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, onDecision, refined, setRefinePanel]);

  // Focus the edit textarea when switching to edit mode
  useEffect(() => {
    if (isEditing && panelRef.current) {
      const textarea = panelRef.current.querySelector('textarea');
      textarea?.focus();
    }
  }, [isEditing]);

  const handleDecision = (decision: RefineDecision) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRefinePanel(null);
    onDecision(decision);
  };

  const handleEditSubmit = () => {
    if (editText.trim()) {
      handleDecision('edit');
    }
  };

  return (
    <div
      ref={panelRef}
      className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden animate-message"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">✨ Refine Prompt</span>
          {countdown !== null && !isEditing && (
            <span className="text-xs text-muted-foreground">
              auto-send in {countdown}s
            </span>
          )}
        </div>
        <button
          onClick={() => handleDecision('original')}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Cancel (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {isEditing ? (
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground font-medium">
              Edit refined prompt:
            </label>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Edit the refined prompt..."
            />
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  setEditText(refined);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleEditSubmit}
                disabled={!editText.trim()}
              >
                <Check className="h-3 w-3 mr-1" />
                Use Edit
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Original */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Original
              </div>
              <div className="text-sm text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
                {original.length > 200 ? original.slice(0, 200) + '...' : original}
              </div>
            </div>

            {/* Refined (Original Language) */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 font-medium uppercase tracking-wider">
                Refined <span className="text-muted-foreground font-normal">(your language)</span>
              </div>
              <div
                className={cn(
                  'text-sm bg-yellow-500/10 border border-yellow-500/20 rounded-md px-3 py-2 cursor-pointer',
                  'hover:bg-yellow-500/20 transition-colors',
                )}
                onClick={() => handleDecision('refined')}
                title="Click or press Enter to use this version"
              >
                {refined.length > 300 ? refined.slice(0, 300) + '...' : refined}
              </div>
            </div>

            {/* English */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 font-medium uppercase tracking-wider">
                <Globe className="h-3 w-3" />
                English
              </div>
              <div
                className={cn(
                  'text-sm bg-blue-500/10 border border-blue-500/20 rounded-md px-3 py-2 cursor-pointer',
                  'hover:bg-blue-500/20 transition-colors',
                )}
                onClick={() => handleDecision('english')}
                title="Press e to use English version"
              >
                {english.length > 300 ? english.slice(0, 300) + '...' : english}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer with action buttons */}
      {!isEditing && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t bg-muted/20">
          <div className="flex gap-1 text-xs text-muted-foreground">
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono">Enter</kbd>
            <span>refined</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">e</kbd>
            <span>English</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">o</kbd>
            <span>original</span>
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">t</kbd>
            <span>edit</span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDecision('original')}
              className="text-xs"
            >
              <X className="h-3 w-3 mr-1" />
              Original
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              className="text-xs"
            >
              <Edit3 className="h-3 w-3 mr-1" />
              Edit
            </Button>
            <Button
              size="sm"
              onClick={() => handleDecision('refined')}
              className="text-xs bg-yellow-600 hover:bg-yellow-700 text-white"
            >
              <Check className="h-3 w-3 mr-1" />
              Use Refined
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
