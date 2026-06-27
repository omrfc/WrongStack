import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useUIStore } from '@/stores';

interface PromptVar {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
}
interface PromptMeta {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  source: string;
  favorite: boolean;
  variables: PromptVar[];
}
interface CategoryCount {
  id: string;
  label: string;
  count: number;
}

const SOURCE_GLYPH: Record<string, string> = {
  builtin: '📦',
  user: '👤',
  project: '📁',
  synced: '☁',
};

/** Fill {{name}} placeholders locally; leave unknown placeholders intact. */
function render(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, raw: string) =>
    Object.hasOwn(values, raw.trim()) && values[raw.trim()]
      ? (values[raw.trim()] as string)
      : whole,
  );
}

/**
 * Prompt library modal — browse / search / filter-by-category / preview /
 * fill {{variables}} / insert into the chat input. Opened from the `/prompt`
 * slash command (ui-store `promptLibraryOpen`).
 */
export function PromptLibraryModal() {
  const { client } = useWebSocket();
  const open = useUIStore((s) => s.promptLibraryOpen);
  const setOpen = useUIStore((s) => s.setPromptLibraryOpen);
  const requestPromptInsert = useUIStore((s) => s.requestPromptInsert);

  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selected, setSelected] = useState<PromptMeta | null>(null);
  const [content, setContent] = useState('');
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  // Load list on open.
  useEffect(() => {
    if (!open || !client) return;
    const onList = (msg: unknown) => {
      const p = (msg as { payload: { prompts?: PromptMeta[]; categories?: CategoryCount[] } })
        .payload;
      setPrompts(p.prompts ?? []);
      setCategories(p.categories ?? []);
    };
    client.on('prompts.list', onList as (m: unknown) => void);
    client.send({ type: 'prompts.list' });
    setTimeout(() => searchRef.current?.focus(), 50);
    return () => client.off('prompts.list', onList as (m: unknown) => void);
  }, [open, client]);

  // Fetch full content when a prompt is selected.
  useEffect(() => {
    if (!selected || !client) return;
    setContent('');
    setVarValues(
      Object.fromEntries((selected.variables ?? []).map((v) => [v.name, v.default ?? ''])),
    );
    const onContent = (msg: unknown) => {
      const p = (msg as { payload: { slug: string; content: string; found: boolean } }).payload;
      if (p.slug === selected.slug && p.found) setContent(p.content);
    };
    client.on('prompts.content', onContent as (m: unknown) => void);
    client.send({ type: 'prompts.content', payload: { slug: selected.slug } });
    return () => client.off('prompts.content', onContent as (m: unknown) => void);
  }, [selected, client]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prompts.filter((p) => {
      if (favoritesOnly && !p.favorite) return false;
      if (activeCat && p.category !== activeCat) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.slug.includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [prompts, query, activeCat, favoritesOnly]);

  const missing = useMemo(
    () =>
      (selected?.variables ?? [])
        .filter((v) => v.required && !varValues[v.name])
        .map((v) => v.name),
    [selected, varValues],
  );

  const doInsert = useCallback(() => {
    if (!selected || !content) return;
    client?.send({ type: 'prompts.used', payload: { slug: selected.slug } });
    requestPromptInsert(render(content, varValues));
  }, [selected, content, varValues, requestPromptInsert, client]);

  const toggleFavorite = useCallback(
    (p: PromptMeta) => {
      if (!client) return;
      client.send({ type: 'prompts.favorite', payload: { slug: p.slug, favorite: !p.favorite } });
      setPrompts((prev) =>
        prev.map((x) => (x.slug === p.slug ? { ...x, favorite: !x.favorite } : x)),
      );
    },
    [client],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex h-[80vh] w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: search + categories + results */}
        <div className="flex w-1/2 flex-col border-r border-border">
          <div className="border-b border-border p-3">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts…"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              <button
                onClick={() => setActiveCat(null)}
                className={`rounded px-2 py-0.5 text-xs ${activeCat === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
              >
                All
              </button>
              <button
                onClick={() => setFavoritesOnly((v) => !v)}
                className={`rounded px-2 py-0.5 text-xs ${favoritesOnly ? 'bg-yellow-500 text-black' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
              >
                ★ Favorites
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCat(c.id)}
                  className={`rounded px-2 py-0.5 text-xs ${activeCat === c.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
                >
                  {c.label} ({c.count})
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {filtered.map((p) => (
              <button
                key={p.slug}
                onClick={() => setSelected(p)}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-border/50 px-3 py-2 text-left hover:bg-accent ${selected?.slug === p.slug ? 'bg-accent' : ''}`}
              >
                <div className="flex w-full items-center gap-1 text-sm">
                  <span>{SOURCE_GLYPH[p.source] ?? '•'}</span>
                  <span className="font-medium">{p.title}</span>
                  {p.favorite && <span className="text-yellow-500">★</span>}
                </div>
                <div className="line-clamp-1 text-xs text-muted-foreground">{p.description}</div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">No prompts match.</div>
            )}
          </div>
        </div>

        {/* Right: preview + variables + insert */}
        <div className="flex w-1/2 flex-col">
          {selected ? (
            <>
              <div className="flex items-start justify-between border-b border-border p-3">
                <div>
                  <div className="text-sm font-semibold">{selected.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {selected.category} · {selected.slug}
                  </div>
                </div>
                <button
                  onClick={() => toggleFavorite(selected)}
                  className="text-lg"
                  title="Toggle favorite"
                >
                  {selected.favorite ? '★' : '☆'}
                </button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                <pre className="whitespace-pre-wrap break-words text-xs text-foreground">
                  {content || '…'}
                </pre>
                {(selected.variables ?? []).length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground">Variables</div>
                    {selected.variables.map((v) => (
                      <div key={v.name}>
                        <label className="text-xs text-muted-foreground">
                          {v.name}
                          {v.required ? ' *' : ''}
                          {v.description ? ` — ${v.description}` : ''}
                        </label>
                        <input
                          value={varValues[v.name] ?? ''}
                          onChange={(e) =>
                            setVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                          }
                          className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="border-t border-border p-3">
                <button
                  onClick={doInsert}
                  disabled={!content || missing.length > 0}
                  className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  {missing.length > 0 ? `Fill: ${missing.join(', ')}` : 'Insert into chat'}
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
              Select a prompt to preview and insert.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
