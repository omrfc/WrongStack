import { ArrowRight, Lightbulb, MousePointerClick } from 'lucide-react';
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
export function fillInput(text: string): void {
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
 * Renders extracted next steps as a prominent, clickable action bar.
 * Each button fills the chat input with the suggestion text.
 *
 * Design goals:
 * - Immediately noticeable after the agent's reply (not buried in tiny text)
 * - Distinct from the message body via card-like appearance and accent colors
 * - One-click execution — no copy-paste, just click and send
 */
export function NextStepsBar({
  steps,
}: {
  steps: NextStep[];
}): React.ReactElement | null {
  if (steps.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.03] overflow-hidden animate-message">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-primary/10 bg-primary/[0.04]">
        <span className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/15 text-primary">
          <Lightbulb className="h-3 w-3" />
        </span>
        <span className="text-xs font-semibold text-foreground/90">Next steps</span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          click to fill input
        </span>
      </div>

      {/* ── Steps ── */}
      <div className="flex flex-col p-2 gap-1">
        {steps.map((s) => (
          <button
            key={s.index}
            type="button"
            onClick={() => fillInput(s.text)}
            className="group flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-lg transition-all
                       hover:bg-primary/[0.08] hover:shadow-sm
                       border border-transparent hover:border-primary/20"
            title={`Click to fill: ${s.text}`}
          >
            {/* Index badge */}
            <span className="flex items-center justify-center w-5 h-5 rounded-md bg-muted/80 group-hover:bg-primary/20
                             text-[11px] font-mono font-semibold tabular-nums shrink-0
                             text-muted-foreground group-hover:text-primary transition-colors">
              {s.index}
            </span>
            {/* Arrow */}
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
            {/* Text */}
            <span className="text-sm leading-snug text-foreground/80 group-hover:text-foreground transition-colors flex-1 min-w-0">
              {s.text}
            </span>
            {/* Click indicator — visible on hover */}
            <MousePointerClick className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 text-primary/60 transition-all shrink-0" />
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
