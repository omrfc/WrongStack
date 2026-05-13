import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Box, useApp } from 'ink';
import type {
  Agent,
  AttachmentStore,
  EventBus,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { InputBuilder } from '@wrongstack/core';
import { History, type HistoryEntry } from './components/history.js';
import { Input, type KeyEvent } from './components/input.js';
import { StatusBar } from './components/status-bar.js';
import { FilePicker } from './components/file-picker.js';
import { searchFiles } from './file-search.js';
import { readClipboardImage } from './clipboard.js';

export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter;
  model: string;
  banner?: boolean;
  onExit: (code: number) => void;
}

type DraftEntry = HistoryEntry extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

type State = {
  entries: HistoryEntry[];
  buffer: string;
  cursor: number;
  placeholders: string[];
  streamingText: string;
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  interrupts: number;
  hint: string;
  nextId: number;
  picker: { open: boolean; query: string; matches: string[]; selected: number };
};

type Action =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'addPlaceholder'; ph: string }
  | { type: 'clearInput' }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  | { type: 'hint'; text: string }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number };

const MAX_HISTORY_ENTRIES = 500;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addEntry': {
      const appended = [
        ...state.entries,
        { ...action.entry, id: state.nextId } as HistoryEntry,
      ];
      const trimmed =
        appended.length > MAX_HISTORY_ENTRIES
          ? appended.slice(appended.length - MAX_HISTORY_ENTRIES)
          : appended;
      return { ...state, entries: trimmed, nextId: state.nextId + 1 };
    }
    case 'setBuffer':
      return { ...state, buffer: action.buffer, cursor: action.cursor };
    case 'addPlaceholder':
      return { ...state, placeholders: [...state.placeholders, action.ph] };
    case 'clearInput':
      return {
        ...state,
        buffer: '',
        cursor: 0,
        placeholders: [],
        picker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'streamDelta':
      return { ...state, streamingText: state.streamingText + action.delta };
    case 'streamReset':
      return { ...state, streamingText: '' };
    case 'status':
      return { ...state, status: action.status };
    case 'interrupt':
      return { ...state, interrupts: state.interrupts + 1 };
    case 'resetInterrupts':
      return { ...state, interrupts: 0 };
    case 'hint':
      return { ...state, hint: action.text };
    case 'pickerOpen':
      return {
        ...state,
        picker: { open: true, query: action.query, matches: state.picker.matches, selected: 0 },
      };
    case 'pickerClose':
      return {
        ...state,
        picker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'pickerSetMatches':
      // Guard against stale async results — only apply if query still matches.
      if (!state.picker.open || state.picker.query !== action.query) return state;
      return {
        ...state,
        picker: {
          ...state.picker,
          matches: action.matches,
          selected: Math.min(state.picker.selected, Math.max(0, action.matches.length - 1)),
        },
      };
    case 'pickerMove': {
      const n = state.picker.matches.length;
      if (n === 0) return state;
      const next = (state.picker.selected + action.delta + n) % n;
      return { ...state, picker: { ...state.picker, selected: next } };
    }
  }
}

const PASTE_THRESHOLD_CHARS = 200;

export function App({
  agent,
  slashRegistry,
  attachments,
  events,
  tokenCounter,
  model,
  banner = true,
  onExit,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, {
    entries: banner
      ? [
          {
            id: 0,
            kind: 'info' as const,
            text: 'WrongStack — Built on the wrong stack. Shipped anyway. (/help, /exit)',
          },
        ]
      : [],
    buffer: '',
    cursor: 0,
    placeholders: [],
    streamingText: '',
    status: 'idle' as const,
    interrupts: 0,
    hint: '',
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
  });

  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  const activeCtrlRef = useRef<AbortController | null>(null);
  const projectRoot = agent.ctx.projectRoot;

  // Detect an active `@<query>` token at the cursor and drive the picker.
  // Reruns whenever buffer/cursor changes — guards against stale results.
  useEffect(() => {
    const detected = detectAtToken(state.buffer, state.cursor);
    if (!detected) {
      if (state.picker.open) dispatch({ type: 'pickerClose' });
      return;
    }
    if (!state.picker.open || state.picker.query !== detected.query) {
      dispatch({ type: 'pickerOpen', query: detected.query });
    }
    let cancelled = false;
    searchFiles(projectRoot, detected.query, 8)
      .then((matches) => {
        if (!cancelled) {
          dispatch({ type: 'pickerSetMatches', query: detected.query, matches });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, state.cursor, projectRoot]);

  const pasteClipboardImage = async (): Promise<void> => {
    const builder = builderRef.current;
    if (!builder) return;
    try {
      const img = await readClipboardImage();
      if (!img) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No image on the clipboard.' },
        });
        return;
      }
      const placeholder = await builder.appendImage(img.base64, img.mediaType);
      const kb = (img.bytes / 1024).toFixed(0);
      dispatch({ type: 'addPlaceholder', ph: `${placeholder} (PNG ${kb}KB)` });
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard image error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  };

  const acceptPickerSelection = async (): Promise<void> => {
    const { open, matches, selected } = state.picker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const builder = builderRef.current;
    if (!builder) return;

    // Find the @-token span we're replacing.
    const tok = detectAtToken(state.buffer, state.cursor);
    if (!tok) {
      dispatch({ type: 'pickerClose' });
      return;
    }

    // Attach the file via the builder. The builder appends "[file #N]" to its
    // own display string, but we want to put the placeholder inline in the
    // visible buffer (replacing @query) so the user sees it.
    const absPath = path.isAbsolute(picked) ? picked : path.join(projectRoot, picked);
    try {
      const data = await fs.readFile(absPath, 'utf8');
      const placeholder = await builder.appendFile({
        kind: 'file',
        data,
        meta: { filename: picked, label: picked },
      });
      const before = state.buffer.slice(0, tok.start);
      const after = state.buffer.slice(tok.end);
      const next = `${before}${placeholder}${after}`;
      dispatch({
        type: 'setBuffer',
        buffer: next,
        cursor: tok.start + placeholder.length,
      });
      dispatch({ type: 'pickerClose' });
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: `Attach failed: ${err instanceof Error ? err.message : String(err)}` },
      });
      dispatch({ type: 'pickerClose' });
    }
  };

  // Subscribe to provider streaming events.
  useEffect(() => {
    const offDelta = events.on('provider.text_delta', (e) => {
      dispatch({ type: 'streamDelta', delta: e.text });
    });
    const offTool = events.on('tool.executed', (e) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'tool', name: e.name, durationMs: e.durationMs, ok: e.ok },
      });
    });
    return () => {
      offDelta();
      offTool();
    };
  }, [events]);

  // Handle SIGINT: first cancels current iteration, second exits.
  useEffect(() => {
    const onSigint = () => {
      if (state.interrupts >= 1 && state.status === 'idle') {
        exit();
        onExit(130);
        return;
      }
      dispatch({ type: 'interrupt' });
      if (activeCtrlRef.current) {
        activeCtrlRef.current.abort();
        dispatch({ type: 'status', status: 'aborting' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Iteration cancelled. Press Ctrl+C again to exit.' },
        });
      } else {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Press Ctrl+C again to exit.' },
        });
      }
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, [state.interrupts, state.status, exit, onExit]);

  const handleKey = async (input: string, key: KeyEvent) => {
    if (state.status !== 'idle') return;

    // Picker takes precedence over normal input handling when open.
    if (state.picker.open) {
      if (key.escape) {
        dispatch({ type: 'pickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'pickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'pickerMove', delta: 1 });
        return;
      }
      if (key.return) {
        await acceptPickerSelection();
        return;
      }
      // Any other key falls through to normal text handling, which will
      // either extend the @-query (e.g. typing more chars) or break it
      // (e.g. typing a space) — handled below.
    }

    if (key.return) {
      await submit();
      return;
    }

    if (key.backspace || key.delete) {
      if (state.cursor === 0) return;
      const next = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor - 1 });
      return;
    }

    if (key.leftArrow) {
      if (state.cursor > 0) dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.cursor - 1 });
      return;
    }
    if (key.rightArrow) {
      if (state.cursor < state.buffer.length)
        dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.cursor + 1 });
      return;
    }
    if (key.ctrl && input === 'a') {
      dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: 0 });
      return;
    }
    if (key.ctrl && input === 'e') {
      dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.buffer.length });
      return;
    }
    if (key.ctrl && input === 'u') {
      dispatch({ type: 'setBuffer', buffer: '', cursor: 0 });
      return;
    }

    // Alt+V → read image from clipboard and attach as [image #N].
    if (key.meta && input === 'v') {
      await pasteClipboardImage();
      return;
    }

    if (!input || key.ctrl || key.meta) return;

    // Strip bracketed-paste markers if the terminal sent them through.
    // The wrapped payload is always treated as a paste regardless of size.
    let bracketedPaste = false;
    if (input.includes('\x1b[200~') || input.includes('\x1b[201~')) {
      input = input.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      bracketedPaste = true;
    }

    // Paste detection: chunks larger than threshold or containing a newline
    // are routed through InputBuilder instead of inserted character-by-char.
    if (bracketedPaste || input.length > PASTE_THRESHOLD_CHARS || input.includes('\n')) {
      const builder = builderRef.current;
      if (!builder) return;
      const ph = await builder.appendPaste(input);
      if (ph) {
        const lineCount = input.split('\n').length;
        dispatch({ type: 'addPlaceholder', ph: `${ph} (${lineCount} lines)` });
      } else {
        const next =
          state.buffer.slice(0, state.cursor) + input + state.buffer.slice(state.cursor);
        dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor + input.length });
      }
      return;
    }

    const next = state.buffer.slice(0, state.cursor) + input + state.buffer.slice(state.cursor);
    dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor + input.length });
  };

  const submit = async () => {
    const raw = state.buffer;
    const trimmed = raw.trim();
    if (!trimmed && state.placeholders.length === 0) return;

    dispatch({ type: 'resetInterrupts' });
    dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed || '(attachments only)' } });

    if (trimmed.startsWith('/')) {
      dispatch({ type: 'clearInput' });
      try {
        const res = await slashRegistry.dispatch(trimmed, agent.ctx);
        if (res?.message) {
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        }
        if (res?.exit) {
          exit();
          onExit(0);
        }
      } catch (err) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    const builder = builderRef.current;
    if (!builder) return;
    if (trimmed) builder.appendText(trimmed);
    const blocks = await builder.submit();
    dispatch({ type: 'clearInput' });

    const ctrl = new AbortController();
    activeCtrlRef.current = ctrl;
    dispatch({ type: 'status', status: 'running' });

    try {
      const startedAt = Date.now();
      const before = tokenCounter?.total();
      const costBefore = tokenCounter?.estimateCost().total ?? 0;
      const result = await agent.run(blocks, { signal: ctrl.signal });

      // Flush the streamed text into history as a single assistant entry.
      if (state.streamingText || (result.status === 'done' && result.finalText)) {
        const text = state.streamingText || result.finalText || '';
        if (text.trim()) dispatch({ type: 'addEntry', entry: { kind: 'assistant', text } });
      }
      dispatch({ type: 'streamReset' });

      if (result.status === 'aborted') {
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: 'Aborted.' } });
      } else if (result.status === 'failed') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'error',
            text: `Failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
          },
        });
      } else if (result.status === 'max_iterations') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Hit max iterations (${result.iterations}).` },
        });
      }

      if (tokenCounter && before) {
        const after = tokenCounter.total();
        const costAfter = tokenCounter.estimateCost().total;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'turn-summary',
            text: `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`,
          },
        });
      }
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      activeCtrlRef.current = null;
      dispatch({ type: 'status', status: 'idle' });
    }
  };

  const inputHint = useMemo(() => {
    if (state.status !== 'idle') return '';
    if (state.buffer.startsWith('/')) return 'slash command — Enter to dispatch';
    if (state.picker.open) return '';
    return '';
  }, [state.buffer, state.status, state.picker.open]);

  return (
    <Box flexDirection="column">
      <History entries={state.entries} streamingText={state.streamingText} />
      <Input
        value={state.buffer}
        cursor={state.cursor}
        placeholders={state.placeholders}
        disabled={state.status !== 'idle'}
        hint={inputHint}
        onKey={handleKey}
      />
      {state.picker.open ? (
        <FilePicker
          query={state.picker.query}
          matches={state.picker.matches}
          selected={state.picker.selected}
        />
      ) : null}
      <StatusBar
        model={model}
        state={state.status}
        tokenCounter={tokenCounter}
        hint={state.hint}
      />
    </Box>
  );
}

/**
 * Find an active `@<query>` token at the cursor. The token starts at the
 * last `@` not preceded by a non-whitespace char, and runs up to the cursor
 * (no whitespace allowed inside). Returns null if no active token.
 */
export function detectAtToken(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = buffer.charCodeAt(i);
    if (ch === 64 /* @ */) {
      // Must be at the start of buffer or preceded by whitespace.
      if (i === 0 || /\s/.test(buffer[i - 1] ?? '')) {
        return { start: i, end: cursor, query: buffer.slice(i + 1, cursor) };
      }
      return null;
    }
    if (ch === 32 /* space */ || ch === 9 /* tab */ || ch === 10 /* nl */) return null;
    i--;
  }
  return null;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
