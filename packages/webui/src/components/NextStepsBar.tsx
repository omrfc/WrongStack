import { ArrowRight } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';

/** A single next-step suggestion extracted from the agent's output. */
export interface NextStep {
  index: number;
  text: string;
}

/** Regex that matches "💡 Next steps" heading + numbered items up to a blank line. */
const NEXT_STEPS_RE = /💡\s*Next steps?\s*\n+((?:\d+\.\s+.+\n?)+)/i;

/**
 * Parse `💡 Next steps` from a markdown string.
 * Returns an array of { index, text } — index is 1-based.
 */
export function parseNextSteps(content: string): NextStep[] {
  const match = NEXT_STEPS_RE.exec(content);
  if (!match?.[1]) return [];

  const block = match[1];
  const lines = block.split('\n').filter(Boolean);
  const steps: NextStep[] = [];

  for (const line of lines) {
    const m = /^(\d+)\.\s+(.+)$/.exec(line.trim());
    if (m) {
      steps.push({ index: Number.parseInt(m[1]!, 10), text: m[2]!.trim() });
    }
  }

  return steps.slice(0, 6); // cap at 6
}

/**
 * Fill the chat input textarea with the given text.
 * Uses the native setter to trigger React's onChange.
 */
function fillInput(text: string): void {
  const ta = document.querySelector('textarea');
  if (!ta) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

/**
 * Renders extracted next steps as clickable buttons.
 * Each button fills the chat input with the suggestion text.
 */
export function NextStepsBar({
  steps,
}: {
  steps: NextStep[];
}): React.ReactElement | null {
  if (steps.length === 0) return null;

  return (
    <div className="mt-3 pt-2 border-t border-border/50">
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s) => (
          <button
            key={s.index}
            type="button"
            onClick={() => fillInput(s.text)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] border border-border/60 bg-muted/40 hover:bg-muted hover:border-primary/40 text-foreground/80 hover:text-foreground transition-colors group"
            title={`Execute: ${s.text}`}
          >
            <span className="font-mono text-[10px] text-muted-foreground group-hover:text-primary tabular-nums">
              {s.index}
            </span>
            <ArrowRight className="h-2.5 w-2.5 text-muted-foreground group-hover:text-primary" />
            <span className="line-clamp-1 max-w-[28rem]">{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Hook-friendly version: takes raw markdown content and returns parsed steps.
 */
export function useNextSteps(content: string): NextStep[] {
  return useMemo(() => parseNextSteps(content), [content]);
}
