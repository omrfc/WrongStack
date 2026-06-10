import { cn } from '@/lib/utils';
import { fmtTok } from '@/components/ChatView/utils';

/**
 * ContextBar — visual context-window fill indicator matching TUI's
 * sub-cell-precise bar (Unicode 1/8 block characters rendered as CSS).
 *
 * Color coding (matches TUI):
 * - green  (< 60%) — healthy
 * - yellow (60–75%) — warning
 * - red    (≥ 75%)  — critical
 *
 * The bar uses 10 segments with 3 sub-segments each (matching the TUI's
 * 1/8-block precision: ▏▎▍▌▋▊▉█). Each segment is 3.33% of the bar.
 */
export interface ContextBarProps {
  /** Context fill percentage 0–100 (can exceed 100 for over-full contexts). */
  pct: number;
  /** Current token count (raw number). */
  tokens?: number | undefined;
  /** Max context window tokens. */
  maxTokens?: number | undefined;
  /** Number of visual segments (default 10, matches TUI). */
  segments?: number | undefined;
  /** Whether to show the token numbers (default true). */
  showTokens?: boolean | undefined;
  /** Additional class name. */
  className?: string | undefined;
  /** Click handler — use to show a breakdown modal. */
  onClick?: (() => void) | undefined;
}

const SEGMENT_FILL: Record<number, string> = {
  0: '',
  1: '▏',
  2: '▎',
  3: '▍',
  4: '▌',
  5: '▋',
  6: '▊',
  7: '▉',
  8: '█',
};

function getColor(pct: number): string {
  if (pct >= 75) return 'bg-destructive';
  if (pct >= 60) return 'bg-[hsl(var(--warning))]';
  return 'bg-[hsl(var(--success))]';
}

function getTextColor(pct: number): string {
  if (pct >= 75) return 'text-destructive';
  if (pct >= 60) return 'text-[hsl(var(--warning))]';
  return 'text-[hsl(var(--success))]';
}

export function ContextBar({
  pct,
  tokens,
  maxTokens,
  segments = 10,
  showTokens = true,
  className,
  onClick,
}: ContextBarProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(200, pct)); // cap visual at 200%
  const eighths = Math.round((clamped / 100) * segments * 8);

  // Build bar segments
  const bars: Array<{ fill: number }> = [];
  let remaining = eighths;
  for (let i = 0; i < segments; i++) {
    const segFill = Math.min(8, remaining);
    bars.push({ fill: segFill });
    remaining -= segFill;
  }

  const pctText = pct >= 100 ? `${Math.round(pct)}%+` : `${Math.round(pct)}%`;
  const tokenText =
    showTokens && tokens !== undefined && maxTokens !== undefined && maxTokens > 0
      ? ` ${fmtTok(tokens)}/${fmtTok(maxTokens)}`
      : '';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-mono font-medium shrink-0',
        onClick && 'cursor-pointer hover:ring-1 hover:ring-ring transition-shadow',
        getTextColor(pct),
        pct >= 75
          ? 'bg-red-500/10'
          : pct >= 60
            ? 'bg-amber-500/10'
            : 'bg-emerald-500/10',
        className,
      )}
      title={
        (tokens !== undefined && maxTokens !== undefined
          ? `Context window: ${tokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pctText})`
          : `Context window: ${pctText}`) +
        (onClick ? ' — click for breakdown' : '')
      }
      onClick={onClick ? (e: React.MouseEvent) => { e.stopPropagation(); onClick(); } : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <span className="inline-flex tracking-[-0.1em]">
        {bars.map((b, i) => (
          <span
            key={i}
            className={cn(
              'tabular-nums',
              b.fill > 0 ? getTextColor(pct) : 'text-muted-foreground/30',
            )}
          >
            {SEGMENT_FILL[b.fill] ?? ' '}
          </span>
        ))}
      </span>
      <span>{pctText}</span>
      {tokenText && <span className="tabular-nums">{tokenText}</span>}
    </span>
  );
}

/**
 * Horizontal CSS-based context fill bar — an alternative to the
 * Unicode character bar that uses CSS widths for smooth rendering.
 */
export function ContextFillBar({
  pct,
  tokens,
  maxTokens,
  showTokens = true,
  className,
  onClick,
}: Omit<ContextBarProps, 'segments'>): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, pct));
  const pctText = `${Math.round(pct)}%`;
  const tokenText =
    showTokens && tokens !== undefined && maxTokens !== undefined && maxTokens > 0
      ? ` ${fmtTok(tokens)}/${fmtTok(maxTokens)}`
      : '';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        onClick && 'cursor-pointer hover:opacity-80 transition-opacity',
        className,
      )}
      title={
        (tokens !== undefined && maxTokens !== undefined
          ? `Context window: ${tokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pctText})`
          : `Context window: ${pctText}`) +
        (onClick ? ' — click for breakdown' : '')
      }
      onClick={onClick ? (e: React.MouseEvent) => { e.stopPropagation(); onClick(); } : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted shrink-0">
        <span
          className={cn('h-full rounded-full transition-all duration-300', getColor(pct))}
          style={{ width: `${Math.max(2, clamped)}%` }}
        />
      </span>
      <span
        className={cn('text-[11px] font-mono tabular-nums font-medium', getTextColor(pct))}
      >
        {pctText}
      </span>
      {tokenText && (
        <span className="text-[10px] text-muted-foreground tabular-nums">{tokenText}</span>
      )}
    </span>
  );
}
