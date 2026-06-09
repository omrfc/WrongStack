import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useHistoryStore, useSessionStore, useUIStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import type { LucideIcon } from 'lucide-react';
import {
  ArchiveRestore,
  ArrowRight,
  Bug,
  Clock,
  KeyRound,
  Keyboard,
  Search,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';

interface PromptCard {
  icon: LucideIcon;
  title: string;
  hint: string;
  tone: string;
  prompts: string[];
}

const CARDS: PromptCard[] = [
  {
    icon: Search,
    title: 'Explore',
    hint: 'Understand the code before changing it',
    tone: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
    prompts: [
      'Walk me through this codebase: what are the top-level packages or modules, what does each do, and how do they depend on one another? What cross-cutting patterns or abstractions should I understand first?',
      'Find the public API surface of this project — all exported functions, classes, and types that external consumers rely on. Flag any that lack documentation or have unclear contracts.',
      'Map the data flow for a single user action from entry point to persistence. Where does validation happen? Where are side effects triggered? Show me the call chain and any middleware involved.',
    ],
  },
  {
    icon: Wrench,
    title: 'Build',
    hint: 'Add a feature end-to-end',
    tone: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    prompts: [
      'Add a new end-to-end feature. Walk through the layers: data model, API/serialization, business logic, UI (if applicable), and tests. Use existing patterns in this codebase rather than inventing new ones.',
      'Write comprehensive tests for an existing module that has low coverage. Cover happy paths, edge cases, and error states. Use whatever test runner and patterns this project already uses.',
      'Add structured logging or observability to a critical code path. Use the project’s existing logging conventions. Make sure errors carry enough context to debug without re-running.',
    ],
  },
  {
    icon: Bug,
    title: 'Debug',
    hint: 'Track a problem to its root cause',
    tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
    prompts: [
      "Something isn't behaving as expected — data looks wrong, a feature silently fails, or state drifts over time. Help me trace it: start from the symptom, follow the code path, and identify where the logic diverges from intent.",
      'The app works fine locally but breaks in production or CI. Check for environment differences, missing config, race conditions, or infrastructure-level assumptions that might explain the gap.',
      'Performance degrades under load or over time. Profile the hot path, identify bottlenecks (N+1 queries, blocking I/O, large allocations, expensive renders), and propose targeted fixes with measurable impact.',
    ],
  },
  {
    icon: Sparkles,
    title: 'Refactor',
    hint: 'Clean up without breaking behavior',
    tone: 'text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/20',
    prompts: [
      'Find duplicated or near-duplicated logic across the codebase. Extract the shared pieces into a single module or utility, update call sites, and ensure the existing tests still pass.',
      'Identify modules that have grown too large or have too many responsibilities. Propose a split that respects the project’s existing structure, keeps the public API stable, and can be done incrementally.',
      'Audit error handling across the codebase: are errors propagated consistently? Are they wrapped with enough context? Are there swallowed errors or bare panics? Propose a uniform approach and apply it to the worst offenders.',
    ],
  },
];

const SLASH_REFS: Array<{ name: string; hint: string }> = [
  { name: '/help', hint: 'list every slash command' },
  { name: '/diag', hint: 'runtime diagnostics' },
  { name: '/stats', hint: 'tokens · cache · cost · elapsed' },
  { name: '/tools', hint: 'show registered tools' },
  { name: '/memory', hint: 'show remembered notes' },
  { name: '/compact', hint: 'shrink context' },
  { name: '/clear', hint: 'wipe current context' },
  { name: '/new', hint: 'fresh session' },
];

function fillTextarea(text: string): void {
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

export function WelcomeScreen() {
  const { projectName } = useSessionStore();
  const { provider, model } = useConfigStore();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  /** Saved-provider count. We subscribe directly to `providers.saved`
   *  because SettingsPanel is the canonical owner of that state but isn't
   *  always mounted (only when the user is on the Settings tab). undefined
   *  means "not yet fetched" — we skip the CTA in that state to avoid a
   *  flash on first paint. */
  const [savedCount, setSavedCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!wsConnected) return;
    const client = getWSClient(wsUrl);
    const off = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers: unknown[] };
      setSavedCount(p.providers?.length ?? 0);
    });
    client.listSavedProviders();
    return () => {
      off();
    };
  }, [wsConnected, wsUrl]);
  /** Recent prompts harvested from the user's typing history. The same
   *  store that powers ↑/↓ recall in the input — surfacing them here turns
   *  a blank welcome screen into a useful "pick up where you left off"
   *  surface, without any backend round-trip. Limited to 6 so it doesn't
   *  dominate the page. */
  const promptHistory = useUIStore((s) => s.promptHistory);
  const recentPrompts = promptHistory.slice(0, 6);
  /** Recent sessions surfaced as one-click resume buttons. Drives the
   *  "pick back up" workflow without sending the user to the History tab.
   *  We fetch on first paint when connected; the listing is otherwise
   *  populated by the History tab on demand. */
  const { listSessions, resumeSession } = useWebSocket();
  const historyEntries = useHistoryStore((s) => s.entries);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only
  useEffect(() => {
    if (wsConnected && historyEntries.length === 0) listSessions(10);
    // Intentionally only fire on first connect — refreshing on every
    // historyEntries change would loop after the response lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected]);
  const sessionNicknames = useUIStore((s) => s.sessionNicknames);
  const recentSessions = historyEntries.filter((e) => !e.isCurrent).slice(0, 4);

  return (
    <div className="flex flex-col gap-8 py-8 px-2 max-w-5xl mx-auto w-full">
      {/* Hero */}
      <div className="flex flex-col items-center text-center gap-3">
        <div className="relative">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
            <Zap className="h-7 w-7 text-primary-foreground" />
          </div>
          <div className="absolute -inset-3 bg-gradient-to-r from-transparent via-primary/10 to-transparent animate-pulse rounded-full -z-10" />
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Where do you want to start
            {projectName ? (
              <>
                {' in '}
                <span className="text-primary">{projectName}</span>
              </>
            ) : (
              ''
            )}
            ?
          </h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl mx-auto leading-relaxed">
            The agent is connected to your project and ready to read, edit, run commands,
            search the codebase, track todos, and remember context across sessions. Pick a
            starting prompt below, write your own, or type{' '}
            <span className="font-mono text-foreground/80">/</span> for the full command palette.
          </p>
          {provider && model && (
            <p className="text-xs text-muted-foreground/70 mt-2 font-mono">
              {provider} / {model}
            </p>
          )}
        </div>
      </div>

      {/* No-keys CTA — shown only when the backend is connected and the
          providers.saved response confirmed zero registered keys. Lands
          above the prompt cards because clicking those won't work until
          the user adds a key. Quietly disappears once at least one
          provider is registered. */}
      {wsConnected && savedCount === 0 && (
        <button
          type="button"
          onClick={() => setCurrentView('settings')}
          className={cn(
            'group rounded-xl border bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent',
            'border-amber-500/30 hover:border-amber-500/50 transition-colors',
            'p-4 flex items-center gap-4 text-left',
          )}
        >
          <span className="flex items-center justify-center w-12 h-12 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
            <KeyRound className="h-6 w-6" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold mb-1">No API key configured yet</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Register a provider in Settings before sending a message — otherwise the agent has
              nothing to talk to. Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint all
              work.
            </p>
          </div>
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0 group-hover:translate-x-0.5 transition-transform">
            Open Settings <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
      )}

      {/* Prompt cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {CARDS.map((card, ci) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className="rounded-xl border bg-card/40 backdrop-blur-sm p-4 flex flex-col gap-3 animate-message hover:border-primary/20 hover:shadow-sm transition-all"
              style={{ animationDelay: `${ci * 80}ms` }}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center justify-center w-8 h-8 rounded-lg border',
                    card.tone,
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold">{card.title}</h3>
                  <p className="text-xs text-muted-foreground">{card.hint}</p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {card.prompts.map((p, i) => (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list
                    key={i}
                    type="button"
                    onClick={() => fillTextarea(p)}
                    className="text-left text-xs leading-relaxed text-foreground/80 hover:text-foreground border border-transparent hover:border-border/60 rounded-lg px-3 py-2 hover:bg-muted/40 transition-colors line-clamp-3"
                    title={p}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent sessions — one-click resume. We pull the most recent
          non-current sessions so the user can pick back up without leaving
          the welcome screen. Hidden when there's nothing to show (fresh
          install / first run). */}
      {recentSessions.length > 0 && (
        <div className="rounded-xl border bg-muted/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <ArchiveRestore className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Pick back up
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {recentSessions.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => resumeSession(entry.id)}
                className="text-left rounded-lg border border-border/40 bg-background/60 hover:border-primary/40 hover:bg-accent/30 px-3 py-2 transition-colors group/sess"
                title={entry.title}
              >
                <div className="text-sm font-medium truncate text-foreground group-hover/sess:text-primary">
                  {sessionNicknames[entry.id] || entry.title || '(empty)'}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                  {entry.provider}/{entry.model}
                  {entry.tokenTotal > 0 && (
                    <span className="ml-2">· {entry.tokenTotal.toLocaleString()} tok</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent prompts — your own past prompts as one-click refills. Slash
          commands aren't included (the quick-commands block below handles
          those). Shows nothing until you've actually typed something. */}
      {recentPrompts.length > 0 && (
        <div className="rounded-xl border bg-muted/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Recent prompts
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {recentPrompts
              .filter((p) => !p.startsWith('/'))
              .slice(0, 5)
              .map((p, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  key={i}
                  type="button"
                  onClick={() => fillTextarea(p)}
                  className="text-left text-xs leading-relaxed text-muted-foreground hover:text-foreground border border-transparent hover:border-border/60 rounded-lg px-3 py-2 hover:bg-background/60 transition-colors line-clamp-2"
                  title={p}
                >
                  {p}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Slash command quick-ref */}
      <div className="rounded-xl border bg-muted/20 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            Quick commands
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {SLASH_REFS.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => fillTextarea(c.name)}
              className="text-left flex flex-col gap-0.5 rounded-md border border-border/40 bg-background/60 px-3 py-2 hover:border-primary/40 hover:bg-accent/40 transition-colors"
            >
              <span className="font-mono text-xs text-foreground">{c.name}</span>
              <span className="text-[11px] text-muted-foreground truncate">{c.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
