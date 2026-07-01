import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '../../src/components/CodeEditor.js';
import { ThemeProvider } from '../../src/components/ThemeProvider.js';
import { useConfigStore } from '../../src/stores/config-store.js';
import { useFileStore } from '../../src/stores/file-store.js';

const completionProviders: Array<{
  language: string;
  provider: {
    provideCompletionItems: (
      model: MockModel,
      position: { lineNumber: number; column: number },
      context: { triggerCharacter?: string; triggerKind?: number },
      token: { onCancellationRequested: (fn: () => void) => { dispose: () => void } },
    ) => Promise<unknown> | unknown;
  };
}> = [];

const requestCompletion = vi.fn();
const wsListeners = new Map<string, (message: unknown) => void>();

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor(props: { onMount?: (editor: unknown) => void }) {
    React.useEffect(() => {
      // Minimal editor stub covering the methods CodeEditor's onMount touches
      // (selection tracking + context-menu action registration).
      props.onMount?.({
        onDidChangeCursorSelection: () => ({ dispose: () => {} }),
        addAction: () => ({ dispose: () => {} }),
        getSelection: () => null,
        getModel: () => null,
      });
    }, [props]);
    return <div data-testid="mock-monaco-editor" />;
  },
  loader: { config: vi.fn() },
}));

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  },
  KeyMod: { CtrlCmd: 1, Shift: 2 },
  KeyCode: { KeyL: 1 },
  languages: {
    CompletionItemKind: {
      Text: 1,
      Method: 2,
      Function: 3,
      Constructor: 4,
      Field: 5,
      Variable: 6,
      Class: 7,
      Interface: 8,
      Module: 9,
      Property: 10,
      Unit: 11,
      Value: 12,
      Enum: 13,
      Keyword: 14,
      Snippet: 15,
      File: 17,
      Reference: 18,
    },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: vi.fn((language, provider) => {
      completionProviders.push({ language, provider });
      return { dispose: vi.fn() };
    }),
  },
}));

vi.mock('../../src/lib/ws-client.js', () => ({
  getWSClient: vi.fn(() => ({
    on(type: string, handler: (message: unknown) => void) {
      wsListeners.set(type, handler);
      return () => wsListeners.delete(type);
    },
    requestCompletion,
  })),
}));

interface MockModel {
  getOffsetAt(position: { lineNumber: number; column: number }): number;
  getValue(): string;
  getLineContent(lineNumber: number): string;
  getWordUntilPosition(position: { lineNumber: number; column: number }): {
    startColumn: number;
    endColumn: number;
  };
  getLanguageId(): string;
  getVersionId(): number;
}

describe('CodeEditor completions', () => {
  beforeEach(() => {
    completionProviders.length = 0;
    requestCompletion.mockReset();
    wsListeners.clear();
    useConfigStore.setState({ wsUrl: 'ws://127.0.0.1:4571' });
    useFileStore.setState({
      projectRoot: 'D:/repo',
      tree: [],
      openFiles: [
        {
          path: 'src/user-repository.ts',
          content: 'class UserRepository {\n  async findBy',
          dirty: false,
          savedContent: 'class UserRepository {\n  async findBy',
        },
      ],
      activeFilePath: 'src/user-repository.ts',
      treeLoading: false,
      error: null,
    });
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers completion providers for Monaco languages', async () => {
    renderEditor();

    await waitFor(() => {
      expect(completionProviders.some((entry) => entry.language === 'typescript')).toBe(true);
    });
  });

  it('does not ask the server for short automatic prefixes', async () => {
    renderEditor();
    const provider = await getTypeScriptProvider();

    const result = await provider.provideCompletionItems(
      makeModel('fi'),
      { lineNumber: 1, column: 3 },
      {},
      cancellationToken(),
    );

    expect(result).toEqual({ suggestions: [] });
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it('sends a completion request for semantic prefixes and resolves server items', async () => {
    renderEditor();
    const provider = await getTypeScriptProvider();
    const promise = provider.provideCompletionItems(
      makeModel('findBy'),
      { lineNumber: 1, column: 7 },
      {},
      cancellationToken(),
    ) as Promise<{ suggestions: Array<{ label: string; insertText: string }> }>;

    await waitFor(() => expect(requestCompletion).toHaveBeenCalledOnce());
    const payload = requestCompletion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      filePath: 'src/user-repository.ts',
      language: 'typescript',
      lineNumber: 1,
      column: 7,
      prefix: 'findBy',
      suffix: '',
      content: 'findBy',
      allowLlm: true,
    });

    wsListeners.get('completion.result')?.({
      type: 'completion.result',
      payload: {
        requestId: payload.requestId,
        filePath: 'src/user-repository.ts',
        items: [
          {
            label: 'findByEmailAndStatus',
            insertText: 'findByEmailAndStatus(email, status)',
            kind: 'method',
            source: 'lsp',
          },
        ],
      },
    });

    await expect(promise).resolves.toMatchObject({
      suggestions: [
        {
          label: 'findByEmailAndStatus',
          insertText: 'findByEmailAndStatus(email, status)',
        },
      ],
    });
  });
});

function renderEditor() {
  return render(
    <ThemeProvider defaultTheme="light">
      <CodeEditor />
    </ThemeProvider>,
  );
}

async function getTypeScriptProvider() {
  await waitFor(() => {
    expect(completionProviders.some((entry) => entry.language === 'typescript')).toBe(true);
  });
  return completionProviders.find((entry) => entry.language === 'typescript')!.provider;
}

function makeModel(value: string): MockModel {
  return {
    getOffsetAt(position) {
      return position.column - 1;
    },
    getValue() {
      return value;
    },
    getLineContent() {
      return value;
    },
    getWordUntilPosition(position) {
      const startColumn = Math.max(1, position.column - value.length);
      return { startColumn, endColumn: position.column };
    },
    getLanguageId() {
      return 'typescript';
    },
    getVersionId() {
      return 7;
    },
  };
}

function cancellationToken() {
  return {
    onCancellationRequested() {
      return { dispose: vi.fn() };
    },
  };
}
