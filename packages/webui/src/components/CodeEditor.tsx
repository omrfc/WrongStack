import { useFileStore } from '@/stores/file-store';
import { cn } from '@/lib/utils';
import { X, Circle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useTheme } from './ThemeProvider';
// Side-effect import: defines Monaco themes on module load
import './monaco-theme';
import { getMonacoTheme } from './monaco-theme';

// Configure Monaco to use the local package (not CDN)
loader.config({ monaco });

// ── Language mapping by extension ──────────────────────────────────────

const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  html: 'html',
  svg: 'xml',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
};

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANG_MAP[ext] ?? 'plaintext';
}

// ── Tab bar ────────────────────────────────────────────────────────────

function EditorTabs() {
  const openFiles = useFileStore((s) => s.openFiles);
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  const setActiveFile = useFileStore((s) => s.setActiveFile);
  const closeFile = useFileStore((s) => s.closeFile);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex items-center border-b bg-muted/40 overflow-x-auto shrink-0">
      {openFiles.map((f) => {
        const isActive = f.path === activeFilePath;
        const baseName = f.path.split('/').pop() ?? f.path;
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => setActiveFile(f.path)}
            onMouseDown={(e) => {
              // Middle-click to close
              if (e.button === 1) {
                e.preventDefault();
                closeFile(f.path);
              }
            }}
            className={cn(
              'group flex items-center gap-1.5 px-3 py-1.5 text-[11px] border-r whitespace-nowrap min-w-0 max-w-[180px] transition-colors',
              isActive
                ? 'bg-background border-t-2 border-t-primary text-foreground -mb-px'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            title={f.path}
          >
            {f.dirty && (
              <Circle className="h-2 w-2 fill-current text-primary shrink-0" />
            )}
            <span className="truncate">{baseName}</span>
            <X
              className={cn(
                'h-3 w-3 shrink-0 rounded-sm hover:bg-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity',
                isActive && 'opacity-100',
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(f.path);
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

// ── Main editor ────────────────────────────────────────────────────────

export function CodeEditor() {
  const openFiles = useFileStore((s) => s.openFiles);
  const activeFilePath = useFileStore((s) => s.activeFilePath);
  const updateContent = useFileStore((s) => s.updateContent);
  const { theme: appTheme } = useTheme();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const activeFile = useMemo(
    () => openFiles.find((f) => f.path === activeFilePath) ?? null,
    [openFiles, activeFilePath],
  );

  const language = activeFilePath ? getLanguage(activeFilePath) : 'plaintext';
  const monacoTheme = getMonacoTheme();

  // Sync Monaco theme with app theme
  useEffect(() => {
    const resolved = getMonacoTheme();
    monaco.editor.setTheme(resolved);
  }, [appTheme]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    // Ensure the editor uses the correct theme on mount
    monaco.editor.setTheme(getMonacoTheme());
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeFilePath && value !== undefined) {
        updateContent(activeFilePath, value);
      }
    },
    [activeFilePath, updateContent],
  );

  // Keyboard shortcut: Ctrl+S to save, Ctrl+W to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      // Only fire when the editor has focus (or its textarea)
      const inEditor =
        tag === 'textarea' ||
        (e.target as HTMLElement)?.closest('.monaco-editor') !== null;

      if (!mod || !inEditor) return;

      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Dispatch a save event that App.tsx will handle via WS
        window.dispatchEvent(
          new CustomEvent('wrongstack:save-file', {
            detail: { filePath: activeFilePath },
          }),
        );
      }
      if (e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (activeFilePath) {
          useFileStore.getState().closeFile(activeFilePath);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeFilePath]);

  if (openFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No files open
          </p>
          <p className="text-[11px] text-muted-foreground/60">
            Select a file from the explorer to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <EditorTabs />
      <div className="flex-1 relative">
        {activeFile ? (
          <Editor
            key={activeFile.path}
            language={language}
            value={activeFile.content}
            onChange={handleChange}
            theme={monacoTheme}
            onMount={handleMount}
            loading={
              <div className="flex items-center justify-center h-full">
                <span className="text-[11px] text-muted-foreground animate-pulse">
                  Loading editor…
                </span>
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily:
                "'IBM Plex Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              tabSize: 2,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              bracketPairColorization: { enabled: true },
              'semanticHighlighting.enabled': true,
              automaticLayout: true,
              padding: { top: 8 },
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-[11px] text-muted-foreground">
              Select a tab to view its content
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
