import { cn } from '@/lib/utils';
import { useFileStore } from '@/stores/file-store';
import type { TreeNode } from '@/stores/file-store';
import {
  ChevronRight,
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileText,
  FileType,
  Folder,
  FolderGit,
  FolderOpen,
  Folders,
  Loader2,
  Minimize2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── File icon by extension ────────────────────────────────────────────

const EXT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  // ── Code ──
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  // ── Data / config ──
  json: FileJson,
  lock: FileLock,
  // ── Styles ──
  css: FileText,
  scss: FileText,
  less: FileText,
  // ── Markup ──
  html: FileType,
  htm: FileType,
  svg: FileImage,
  xml: FileType,
  // ── Docs ──
  md: FileText,
  mdx: FileText,
  txt: FileText,
  // ── Config / data formats ──
  yml: FileText,
  yaml: FileText,
  toml: FileCog,
  env: FileCog,
  gitignore: FileCog,
  editorconfig: FileCog,
  // ── Scripts ──
  sh: FileCode,
  bash: FileCode,
  zsh: FileCode,
  fish: FileCode,
  ps1: FileCode,
  bat: FileCode,
  // ── Python ──
  py: FileCode,
  pyi: FileCode,
  pyx: FileCode,
  // ── Rust ──
  rs: FileCode,
  // ── Go ──
  go: FileCode,
  // ── Other languages ──
  rb: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  hpp: FileCode,
  sql: FileCode,
  graphql: FileCode,
  // ── Images ──
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  ico: FileImage,
};

/**
 * Returns a Tailwind text color class for a file extension.
 * Colors match the WrongStack semantic palette — same hues used in
 * syntax highlighting and Monaco editor themes for visual consistency.
 */
function fileIconColor(
  name: string,
  isDirectory: boolean,
): string {
  if (isDirectory) {
    // Special directories get distinct colors
    const lower = name.toLowerCase();
    if (lower === '.git') return 'text-orange-500/80 dark:text-orange-400/80';
    if (lower === 'node_modules') return 'text-red-400/60 dark:text-red-500/60';
    if (lower === 'src' || lower === 'lib' || lower === 'packages')
      return 'text-amber-500/70 dark:text-amber-400/70';
    if (lower === 'tests' || lower === 'test' || lower === '__tests__')
      return 'text-emerald-500/70 dark:text-emerald-400/70';
    if (lower === 'dist' || lower === 'build' || lower === '.next')
      return 'text-muted-foreground/50';
    return 'text-amber-500/70 dark:text-amber-400/70';
  }

  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  // ── TypeScript / JavaScript → blue (function/type color) ──
  if (/^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext))
    return 'text-blue-500 dark:text-blue-400';

  // ── JSON / lockfiles → amber (number/constant color) ──
  if (/^(json|lock)$/.test(ext))
    return 'text-amber-500 dark:text-amber-400';

  // ── CSS / styles → teal (regex color) ──
  if (/^(css|scss|less|sass)$/.test(ext))
    return 'text-teal-500 dark:text-teal-400';

  // ── HTML / markup → rose (tag color) ──
  if (/^(html|htm|xml|svg)$/.test(ext))
    return 'text-rose-500 dark:text-rose-400';

  // ── Markdown / docs → violet (decorator color) ──
  if (/^(md|mdx)$/.test(ext))
    return 'text-violet-500 dark:text-violet-400';

  // ── YAML / TOML / env → green (string color) ──
  if (/^(yml|yaml|toml|env)$/.test(ext))
    return 'text-emerald-500 dark:text-emerald-400';

  // ── Shell scripts → warm gray ──
  if (/^(sh|bash|zsh|fish|ps1|bat)$/.test(ext))
    return 'text-orange-400 dark:text-orange-300';

  // ── Python → blue-amber gradient feel ──
  if (/^(py|pyi|pyx)$/.test(ext))
    return 'text-cyan-500 dark:text-cyan-400';

  // ── Rust → rust orange ──
  if (ext === 'rs')
    return 'text-orange-500 dark:text-orange-400';

  // ── Go → go blue ──
  if (ext === 'go')
    return 'text-sky-500 dark:text-sky-400';

  // ── Ruby → red ──
  if (ext === 'rb')
    return 'text-red-400 dark:text-red-400';

  // ── C / C++ → slate ──
  if (/^(c|h|cpp|hpp|cc|hh)$/.test(ext))
    return 'text-slate-500 dark:text-slate-400';

  // ── Images → purple ──
  if (/^(png|jpe?g|gif|webp|ico|svg)$/.test(ext))
    return 'text-purple-500 dark:text-purple-400';

  // ── Config files ──
  if (/^(gitignore|editorconfig|prettierrc|eslintrc)$/.test(ext))
    return 'text-muted-foreground/60';

  return 'text-muted-foreground';
}

function fileIcon(
  name: string,
): React.ComponentType<{ className?: string }> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICONS[ext] ?? File;
}

// ── Tree node ──────────────────────────────────────────────────────────

function TreeNodeItem({
  node,
  depth,
  selectedPath,
  forceExpand,
  onSelect,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  /** null = user-controlled (default), true = expand all, false = collapse all */
  forceExpand: boolean | null;
  onSelect: (filePath: string) => void;
  onOpen: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1); // auto-expand root level
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  const isActive = node.type === 'file' && node.path === activeFilePath;

  // Sync local expanded state when forceExpand changes globally
  useEffect(() => {
    if (forceExpand !== null) setExpanded(forceExpand);
  }, [forceExpand]);

  if (node.type === 'directory') {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const DirIcon = expanded ? FolderOpen : Folder;
    const isGit = node.name === '.git';
    const dirColor = fileIconColor(node.name, true);
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'flex items-center gap-1 w-full text-left px-1 py-0.5 text-[11px] rounded',
            'hover:bg-muted/60 transition-colors',
          )}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          {isGit ? (
            <FolderGit className={cn('h-3.5 w-3.5 shrink-0', dirColor)} />
          ) : (
            <DirIcon className={cn('h-3.5 w-3.5 shrink-0', dirColor)} />
          )}
          <span className="truncate font-medium flex-1 min-w-0">{node.name}</span>
        </button>
        {expanded && hasChildren && (
          <div>
            {(node.children ?? []).map((child) => (
              <TreeNodeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                forceExpand={forceExpand}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
        {expanded && !hasChildren && (
          <div
            className="text-[10px] text-muted-foreground italic py-0.5"
            style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
          >
            empty
          </div>
        )}
      </div>
    );
  }

  // Leaf node (file)
  const Icon = fileIcon(node.name);
  const iconColor = fileIconColor(node.name, false);
  const isSelected = node.path === selectedPath;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      onDoubleClick={(e) => {
        e.preventDefault();
        onOpen(node.path);
      }}
      className={cn(
        'flex items-center gap-1.5 w-full text-left px-1 py-0.5 text-[11px] rounded',
        'hover:bg-muted/60 transition-colors',
        isActive && 'bg-primary/10 text-primary',
        isSelected && !isActive && 'bg-muted/70 ring-1 ring-inset ring-border',
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      <span className="w-3 shrink-0" /> {/* spacer to align with chevron */}
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

// ── File explorer panel ────────────────────────────────────────────────

export function FileExplorer() {
  const tree = useFileStore((s) => s.tree);
  const treeLoading = useFileStore((s) => s.treeLoading);
  const error = useFileStore((s) => s.error);
  const openFiles = useFileStore((s) => s.openFiles);

  // Debounce the loading indicator: only show the spinner after 150ms of
  // continuous loading. Fast refreshes (<150ms) skip the flash entirely.
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (treeLoading) {
      spinnerTimer.current = setTimeout(() => setShowSpinner(true), 150);
    } else {
      if (spinnerTimer.current) clearTimeout(spinnerTimer.current);
      setShowSpinner(false);
    }
    return () => {
      if (spinnerTimer.current) clearTimeout(spinnerTimer.current);
    };
  }, [treeLoading]);

  // Single-click selection highlight (separate from open/sActive state)
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Global expand/collapse: null = user-managed, true = all open, false = all closed.
  // Resets to null when the user manually toggles any individual directory.
  const [globalExpand, setGlobalExpand] = useState<boolean | null>(null);

  // Count total directories in tree for the toolbar badge
  const dirCount = useMemo(() => {
    let count = 0;
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'directory') count++;
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return count;
  }, [tree]);

  // Reset globalExpand when user manually toggles — we detect this by
  // tracking whether the last action was a button click vs a tree click.
  const userInteractedRef = { value: false };
  const handleGlobalCollapse = useCallback(() => {
    userInteractedRef.value = true;
    setGlobalExpand(false);
    // After a beat, allow user to manually toggle again
    setTimeout(() => { userInteractedRef.value = false; }, 400);
  }, []);
  const handleGlobalExpand = useCallback(() => {
    userInteractedRef.value = true;
    setGlobalExpand(true);
    setTimeout(() => { userInteractedRef.value = false; }, 400);
  }, []);

  // Single-click: if already open → switch to that tab. Otherwise → highlight.
  const handleSelect = useCallback(
    (filePath: string) => {
      const existing = openFiles.find((f) => f.path === filePath);
      if (existing) {
        useFileStore.getState().setActiveFile(filePath);
        return;
      }
      // Not open yet — just visually select it
      setSelectedPath((prev) => (prev === filePath ? null : filePath));
    },
    [openFiles],
  );

  // Double-click: always open the file (dispatch to WS server).
  const handleOpen = useCallback((filePath: string) => {
    window.dispatchEvent(
      new CustomEvent('wrongstack:open-file', { detail: { filePath } }),
    );
    setSelectedPath(null);
  }, []);

  // When a file is opened (via double-click or external tab switch),
  // clear the local selection highlight so it doesn't linger.
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  useEffect(() => {
    if (activeFilePath) setSelectedPath(null);
  }, [activeFilePath]);

  if (showSpinner) {
    return (
      <div className="flex items-center justify-center h-full py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 text-[11px] text-destructive">
        Failed to load files: {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Toolbar ── */}
      {tree.length > 0 && dirCount > 0 && (
        <div className="flex items-center gap-0.5 px-2 py-0.5 border-b shrink-0">
          <button
            type="button"
            onClick={handleGlobalExpand}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
              'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
            title="Expand all directories"
          >
            <Folders className="h-3 w-3" />
            <span>Expand all</span>
          </button>
          <button
            type="button"
            onClick={handleGlobalCollapse}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
              'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
            title="Collapse all directories"
          >
            <Minimize2 className="h-3 w-3" />
            <span>Collapse</span>
          </button>
          <span className="ml-auto text-[9px] text-muted-foreground/50 tabular-nums">
            {dirCount} folder{dirCount === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => (
          <TreeNodeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            forceExpand={globalExpand}
            onSelect={handleSelect}
            onOpen={handleOpen}
          />
        ))}
        {tree.length === 0 && (
          <p className="text-[11px] text-muted-foreground italic p-2">
            No files found
          </p>
        )}
      </div>
    </div>
  );
}
