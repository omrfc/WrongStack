import { cn } from '@/lib/utils';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';

const OPTIONS = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
] as const;

/**
 * Segmented Light / Dark / System theme control. Instrument-style: a small
 * bezelled track with the active segment lit in signal-amber.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/70 p-0.5 shadow-sm',
        className,
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${label} theme`}
            aria-label={`${label} theme`}
            onClick={() => setTheme(value)}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-md transition-all duration-150',
              active
                ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
          </button>
        );
      })}
    </div>
  );
}
