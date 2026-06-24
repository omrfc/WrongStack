import { useFileStore } from '@/stores/file-store';
import { useConfigStore } from '@/stores/config-store';
import {
  COMPLETION_CACHE_TTL_MS,
  COMPLETION_DOCUMENT_CHARS,
  COMPLETION_LANGUAGES,
  COMPLETION_PREFIX_CHARS,
  COMPLETION_SUFFIX_CHARS,
  COMPLETION_TIMEOUT_MS,
  buildCompletionCacheKey,
  currentToken,
  getLanguage,
  shouldAllowCompletionLlm,
  shouldAskCompletionServer,
} from '@/lib/completion';
import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import { X, Circle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { WSCompletionResult } from '@/types';
import { useTheme } from './ThemeProvider';
// Side-effect import: defines Monaco themes on module load
import './monaco-theme';
import { getMonacoTheme } from './monaco-theme';

// Configure Monaco to use the local package (not CDN)
loader.config({ monaco });

function completionKind(kind: string | undefined): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'method':
      return monaco.languages.CompletionItemKind.Method;
    case 'function':
      return monaco.languages.CompletionItemKind.Function;
    case 'constructor':
      return monaco.languages.CompletionItemKind.Constructor;
    case 'field':
      return monaco.languages.CompletionItemKind.Field;
    case 'variable':
      return monaco.languages.CompletionItemKind.Variable;
    case 'class':
      return monaco.languages.CompletionItemKind.Class;
    case 'interface':
      return monaco.languages.CompletionItemKind.Interface;
    case 'module':
      return monaco.languages.CompletionItemKind.Module;
    case 'property':
      return monaco.languages.CompletionItemKind.Property;
    case 'unit':
      return monaco.languages.CompletionItemKind.Unit;
    case 'value':
      return monaco.languages.CompletionItemKind.Value;
    case 'enum':
      return monaco.languages.CompletionItemKind.Enum;
    case 'keyword':
      return monaco.languages.CompletionItemKind.Keyword;
    case 'snippet':
      return monaco.languages.CompletionItemKind.Snippet;
    case 'file':
      return monaco.languages.CompletionItemKind.File;
    case 'reference':
      return monaco.languages.CompletionItemKind.Reference;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
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
  const activeFilePathRef = useRef<string | null>(activeFilePath);
  const completionCacheRef = useRef<
    Map<string, { expiresAt: number; items: WSCompletionResult['payload']['items'] }>
  >(new Map());

  const activeFile = useMemo(
    () => openFiles.find((f) => f.path === activeFilePath) ?? null,
    [openFiles, activeFilePath],
  );

  const language = activeFilePath ? getLanguage(activeFilePath) : 'plaintext';
  const monacoTheme = getMonacoTheme();

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  // Sync Monaco theme with app theme
  useEffect(() => {
    const resolved = getMonacoTheme();
    monaco.editor.setTheme(resolved);
  }, [appTheme]);

  useEffect(() => {
    const disposables = COMPLETION_LANGUAGES.map((registeredLanguage) =>
      monaco.languages.registerCompletionItemProvider(registeredLanguage, {
        triggerCharacters: ['.', '_'],
        provideCompletionItems: async (model, position, context, token) => {
          const filePath = activeFilePathRef.current;
          if (!filePath) return { suggestions: [] };

          const offset = model.getOffsetAt(position);
          const value = model.getValue();
          const prefix = value.slice(Math.max(0, offset - COMPLETION_PREFIX_CHARS), offset);
          const suffix = value.slice(offset, offset + COMPLETION_SUFFIX_CHARS);
          const linePrefix = model
            .getLineContent(position.lineNumber)
            .slice(0, Math.max(0, position.column - 1));
          const tokenText = currentToken(linePrefix);
          const trigger = {
            triggerCharacter: context.triggerCharacter,
            triggerKind: context.triggerKind,
          };
          if (!shouldAskCompletionServer(trigger, tokenText)) return { suggestions: [] };

          const requestId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const word = model.getWordUntilPosition(position);
          const range: monaco.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: position.column,
          };
          const client = getWSClient(useConfigStore.getState().wsUrl);
          const toSuggestions = (
            items: WSCompletionResult['payload']['items'],
          ): monaco.languages.CompletionItem[] =>
            items.map((item, index) => ({
              label: item.label,
              kind: completionKind(item.kind),
              insertText: item.insertText,
              detail: item.detail ?? (item.source ? `WrongStack ${item.source}` : undefined),
              documentation: item.documentation,
              sortText: item.sortText ?? `${String(index).padStart(3, '0')}-${item.label}`,
              range,
              insertTextRules: item.kind === 'snippet'
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            }));
          const cacheKey = buildCompletionCacheKey({
            filePath,
            language: model.getLanguageId(),
            lineNumber: position.lineNumber,
            column: position.column,
            versionId: model.getVersionId(),
            triggerCharacter: context.triggerCharacter,
            linePrefix,
            suffix,
          });
          const cached = completionCacheRef.current.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            return { suggestions: toSuggestions(cached.items) };
          }

          return await new Promise<monaco.languages.ProviderResult<monaco.languages.CompletionList>>(
            (resolve) => {
              let settled = false;
              let unsubscribe: () => void = () => {};
              let cancelDisposable: monaco.IDisposable | null = null;
              let timer: number | undefined;
              const finish = (suggestions: monaco.languages.CompletionItem[]) => {
                if (settled) return;
                settled = true;
                unsubscribe();
                if (timer !== undefined) window.clearTimeout(timer);
                cancelDisposable?.dispose();
                resolve({ suggestions });
              };

              unsubscribe = client.on('completion.result', (message) => {
                const result = message as WSCompletionResult;
                if (result.payload.requestId !== requestId) return;
                completionCacheRef.current.set(cacheKey, {
                  expiresAt: Date.now() + COMPLETION_CACHE_TTL_MS,
                  items: result.payload.items,
                });
                finish(toSuggestions(result.payload.items));
              });

              timer = window.setTimeout(() => finish([]), COMPLETION_TIMEOUT_MS);
              cancelDisposable = token.onCancellationRequested(() => finish([]));

              client.requestCompletion({
                requestId,
                filePath,
                language: model.getLanguageId(),
                lineNumber: position.lineNumber,
                column: position.column,
                content: value.length <= COMPLETION_DOCUMENT_CHARS ? value : undefined,
                prefix,
                suffix,
                triggerCharacter: context.triggerCharacter,
                triggerKind: context.triggerKind,
                allowLlm: shouldAllowCompletionLlm(trigger, tokenText),
              });
            },
          );
        },
      }),
    );

    return () => {
      disposables.forEach((disposable) => {
        disposable.dispose();
      });
    };
  }, []);

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
