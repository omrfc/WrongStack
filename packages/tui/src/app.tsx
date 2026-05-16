import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  ContentBlock,
  Director,
  EventBus,
  FleetEvent,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { InputBuilder, formatTodosList } from '@wrongstack/core';
import { Box, useApp } from 'ink';
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { readClipboardImage } from './clipboard.js';
import { ConfirmPrompt } from './components/confirm-prompt.js';
import { FilePicker } from './components/file-picker.js';
import { FleetPanel } from './components/fleet-panel.js';
import { History, type HistoryEntry, formatToolArgs } from './components/history.js';
import { Input, type KeyEvent } from './components/input.js';
import { ModelPicker, type ProviderOption } from './components/model-picker.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatusBar } from './components/status-bar.js';
import { searchFiles } from './file-search.js';
import { type GitInfo, readGitInfo } from './git-info.js';
import { createQueueSlashCommand } from './queue-slash.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
}

/** Per-subagent state tracked live from the FleetBus. */
export interface FleetEntry {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  status: 'idle' | 'running' | 'success' | 'failed' | 'timeout' | 'stopped';
  streamingText: string;
  iterations: number;
  toolCalls: number;
  cost: number;
  startedAt: number;
  lastEventAt: number;
}

/** A registered slash command matched against the user's current / query. */
export interface SlashCommandMatch {
  name: string;
  description: string;
  argsHint?: string;
  isBuiltin: boolean;
}

export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter;
  model: string;
  banner?: boolean;
  /** Persists the queue across crashes; rehydrated on mount, written on every mutation. */
  queueStore?: QueueStore;
  /** Reflects the policy's --yolo flag for the status bar's "⚠ YOLO" chip. */
  yolo?: boolean;
  /** Surfaced in the startup banner. Falls back to "dev" when omitted. */
  appVersion?: string;
  /** Provider id shown in the banner ("openai", "anthropic", …). Defaults to "agent". */
  provider?: string;
  /** Wire family for the configured provider — rendered under provider in the banner. */
  family?: string;
  /** Last 3 chars of the active API key, shown in the banner for "did I pick the right key?" verification. */
  keyTail?: string;
  /**
   * Snapshot the keyed providers (and their model lists) for the
   * `/model` picker. Called every time the picker opens, so the result
   * stays in sync with config edits / new aliases. Async because the
   * host may need to load the models.dev catalog.
   */
  getPickableProviders?: () => Promise<ProviderOption[]>;
  /**
   * Apply a (provider, model) pair after the picker confirms. Returns
   * an error message on failure; null on success. The host owns the
   * actual Provider construction + Context mutation.
   */
  switchProviderAndModel?: (providerId: string, modelId: string) => string | null;
  /**
   * Real max-context token budget for the *active model*, resolved by the
   * CLI via the ModelsRegistry. The provider object only knows its family
   * default (e.g. anthropic = 200k) which is wrong for variants like the
   * 1M-context Opus model. The status bar's context chip uses this when
   * provided and falls back to the provider baseline otherwise.
   */
  effectiveMaxContext?: number;
  onExit: (code: number) => void;
  /** Called when /clear is dispatched — the TUI should wipe its history entries (but keep the banner). */
  onClearHistory?: (
    dispatch: React.Dispatch<{ type: 'clearHistory' } | { type: 'resetContextChip' }>,
  ) => void;

  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }>;
  /**
   * Shared controller for the `/fleet stream on|off` slash command. The
   * App installs a dispatch-backed setter on mount so the slash command
   * can flip the reducer's `streamFleet` flag from the CLI surface.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
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
  /**
   * Live tail of the currently streaming tool's stdout/progress text. Mirrors
   * the assistant `streamingText` pattern but is keyed by tool_use id so the
   * tail is cleared automatically when that tool finishes. Only one tool's
   * stream is shown at a time — multi-tool streaming is rare and stacking
   * tails fights for the same screen space.
   */
  toolStream: { toolUseId: string; name: string; text: string; startedAt: number } | null;
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  interrupts: number;
  hint: string;
  nextId: number;
  picker: { open: boolean; query: string; matches: string[]; selected: number };
  /** Slash command picker — open while typing a / command. */
  slashPicker: { open: boolean; query: string; matches: SlashCommandMatch[]; selected: number };
  /** Tool calls currently in-flight, by tool_use id. Surface in the status bar. */
  runningTools: Map<string, { name: string; startedAt: number }>;
  /** FIFO of user messages typed while the agent was running. Drained when idle. */
  queue: QueueItem[];
  nextQueueId: number;
  /** Previous input strings for up/down navigation. */
  inputHistory: string[];
  /** 0 = current buffer (not in history), 1 = most recent, n = nth most recent. */
  historyIndex: number;
  /** Two-step model picker (provider → model) — opened by `/model`. */
  modelPicker: {
    open: boolean;
    step: 'provider' | 'model';
    providerOptions: ProviderOption[];
    modelOptions: string[];
    selected: number;
    pickedProviderId?: string;
    hint?: string;
  };
  /** Pending tool confirmation — shown in place of the input when active. */
  confirm: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  } | null;
  /** Incremented on /clear so the context chip re-reads from agent.ctx tokens. */
  contextChipVersion: number;
  /** Live fleet state: per-subagent entries from FleetBus events. Keyed by subagentId. */
  fleet: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost. */
  fleetCost: number;
  /**
   * When true, subagent activity (tool calls + assistant messages) is
   * streamed into the main history with an `AGENT#N` prefix. Toggled
   * with `/fleet stream on|off`. Default true so users see what their
   * delegated agents are actually doing.
   */
  streamFleet: boolean;
};

type Action =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'addPlaceholder'; ph: string }
  | { type: 'clearInput' }
  | { type: 'clearHistory' }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  | { type: 'hint'; text: string }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number }
  | { type: 'toolStarted'; id: string; name: string }
  | { type: 'toolEnded'; id?: string; name?: string }
  | { type: 'toolStreamAppend'; toolUseId: string; name: string; text: string; startedAt: number }
  | { type: 'toolStreamClear'; toolUseId?: string; name?: string }
  | { type: 'enqueue'; item: Omit<QueueItem, 'id'> }
  | { type: 'dequeueFirst' }
  | { type: 'queueClear' }
  | { type: 'queueDelete'; positions: number[] }
  | { type: 'slashPickerOpen'; query: string; matches: SlashCommandMatch[] }
  | { type: 'slashPickerClose' }
  | { type: 'slashPickerMove'; delta: number }
  | { type: 'modelPickerOpen'; providers: ProviderOption[] }
  | { type: 'modelPickerClose' }
  | { type: 'modelPickerMove'; delta: number }
  | { type: 'modelPickerPickProvider'; providerId: string; models: string[] }
  | { type: 'modelPickerBack' }
  | { type: 'modelPickerHint'; text?: string }
  | { type: 'historyPush'; text: string }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'confirmOpen'; info: State['confirm'] }
  | { type: 'confirmClose' }
  | { type: 'resetContextChip' }
  // Fleet actions
  | { type: 'fleetSeed'; entries: FleetEntry[]; cost: number }
  | { type: 'fleetSpawn'; id: string; name?: string; provider?: string; model?: string }
  | { type: 'fleetStart'; id: string; taskId?: string }
  | { type: 'fleetDelta'; id: string; text: string }
  | { type: 'fleetTool'; id: string }
  | { type: 'fleetUsage'; id: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: 'fleetDone'; id: string; status: FleetEntry['status']; iterations: number; toolCalls: number }
  | { type: 'fleetCost'; cost: number }
  | { type: 'setStreamFleet'; enabled: boolean };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addEntry': {
      // Append-only. We render finalized entries via Ink's <Static>,
      // which forbids removals or reordering — old items live on in the
      // terminal's native scrollback. Memory growth is bounded by the
      // terminal's own scrollback limits in practice.
      const appended = [...state.entries, { ...action.entry, id: state.nextId } as HistoryEntry];
      return { ...state, entries: appended, nextId: state.nextId + 1 };
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
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'clearHistory': {
      const last = state.entries[state.entries.length - 1];
      return {
        ...state,
        entries: last ? [last] : state.entries,
        queue: [],
        nextQueueId: 1,
      };
    }
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
    case 'toolStarted': {
      const next = new Map(state.runningTools);
      next.set(action.id, { name: action.name, startedAt: Date.now() });
      return { ...state, runningTools: next };
    }
    case 'toolEnded': {
      const next = new Map(state.runningTools);
      if (action.id !== undefined && next.has(action.id)) {
        next.delete(action.id);
        return { ...state, runningTools: next };
      }
      if (action.name !== undefined) {
        // Fall back to clearing the oldest running entry with this name —
        // `tool.executed` doesn't carry the tool_use id, so we approximate.
        for (const [id, info] of next) {
          if (info.name === action.name) {
            next.delete(id);
            return { ...state, runningTools: next };
          }
        }
      }
      return state;
    }
    case 'toolStreamAppend': {
      // Only one tool's stream is shown at a time. If a different tool is
      // currently streaming, switch — last writer wins. Streams from
      // not-yet-acknowledged tools take over as soon as data arrives, which
      // matches user intuition (whatever just produced output is what's
      // visible).
      const cur = state.toolStream;
      if (cur && cur.toolUseId === action.toolUseId) {
        return {
          ...state,
          toolStream: { ...cur, text: cur.text + action.text },
        };
      }
      return {
        ...state,
        toolStream: {
          toolUseId: action.toolUseId,
          name: action.name,
          text: action.text,
          startedAt: action.startedAt,
        },
      };
    }
    case 'toolStreamClear': {
      if (state.toolStream === null) return state;
      // Clear only when the finishing tool matches the streaming one. A
      // stale `tool.executed` for a different tool must not blank the
      // currently-visible stream.
      const t = state.toolStream;
      if (action.toolUseId !== undefined && action.toolUseId !== t.toolUseId) return state;
      if (action.name !== undefined && action.toolUseId === undefined && action.name !== t.name)
        return state;
      return { ...state, toolStream: null };
    }
    case 'enqueue': {
      const item: QueueItem = { ...action.item, id: state.nextQueueId };
      return {
        ...state,
        queue: [...state.queue, item],
        nextQueueId: state.nextQueueId + 1,
      };
    }
    case 'dequeueFirst': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: state.queue.slice(1) };
    }
    case 'queueClear': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: [] };
    }
    case 'queueDelete': {
      if (state.queue.length === 0 || action.positions.length === 0) return state;
      // Positions are 1-based; convert to 0-based set for fast filtering.
      const drop = new Set(action.positions.map((p) => p - 1).filter((i) => i >= 0));
      const filtered = state.queue.filter((_, i) => !drop.has(i));
      if (filtered.length === state.queue.length) return state;
      return { ...state, queue: filtered };
    }
    case 'slashPickerOpen':
      return {
        ...state,
        slashPicker: { open: true, query: action.query, matches: action.matches, selected: 0 },
      };
    case 'slashPickerClose':
      return {
        ...state,
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'slashPickerMove': {
      const n = state.slashPicker.matches.length;
      if (n === 0) return state;
      const next = (state.slashPicker.selected + action.delta + n) % n;
      return { ...state, slashPicker: { ...state.slashPicker, selected: next } };
    }
    case 'historyPush': {
      if (action.text === '' || action.text === state.inputHistory[0]) return state;
      return { ...state, inputHistory: [action.text, ...state.inputHistory].slice(0, 100) };
    }
    case 'historyUp': {
      if (state.inputHistory.length === 0) return state;
      const next = Math.min(state.historyIndex + 1, state.inputHistory.length);
      const entry = state.inputHistory[next - 1] ?? '';
      return { ...state, historyIndex: next, buffer: entry, cursor: entry.length };
    }
    case 'historyDown': {
      if (state.historyIndex === 0) return state;
      const next = state.historyIndex - 1;
      const entry = next === 0 ? '' : (state.inputHistory[next - 1] ?? '');
      return { ...state, historyIndex: next, buffer: entry, cursor: entry.length };
    }
    case 'modelPickerOpen':
      return {
        ...state,
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: action.providers,
          modelOptions: [],
          selected: 0,
          hint: undefined,
        },
      };
    case 'modelPickerClose':
      return {
        ...state,
        modelPicker: {
          open: false,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          selected: 0,
        },
      };
    case 'modelPickerMove': {
      if (!state.modelPicker.open) return state;
      const len =
        state.modelPicker.step === 'provider'
          ? state.modelPicker.providerOptions.length
          : state.modelPicker.modelOptions.length;
      if (len === 0) return state;
      const next = (state.modelPicker.selected + action.delta + len) % len;
      return {
        ...state,
        modelPicker: { ...state.modelPicker, selected: next },
      };
    }
    case 'modelPickerPickProvider':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'model',
          modelOptions: action.models,
          selected: 0,
          pickedProviderId: action.providerId,
          hint: undefined,
        },
      };
    case 'modelPickerBack':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'provider',
          modelOptions: [],
          selected: 0,
          pickedProviderId: undefined,
          hint: undefined,
        },
      };
    case 'modelPickerHint':
      return {
        ...state,
        modelPicker: { ...state.modelPicker, hint: action.text },
      };
    case 'confirmOpen':
      return { ...state, confirm: action.info };
    case 'confirmClose':
      return { ...state, confirm: null };
    case 'resetContextChip':
      return { ...state, contextChipVersion: state.contextChipVersion + 1 };
    // --- Fleet ---
    case 'fleetSeed': {
      const seeded: Record<string, FleetEntry> = {};
      for (const e of action.entries) seeded[e.id] = e;
      return { ...state, fleet: seeded, fleetCost: action.cost };
    }
    case 'fleetSpawn': {
      if (state.fleet[action.id]) return state;
      const entry: FleetEntry = {
        id: action.id,
        name: action.name ?? action.id.slice(0, 8),
        provider: action.provider,
        model: action.model,
        status: 'idle',
        streamingText: '',
        iterations: 0,
        toolCalls: 0,
        cost: 0,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      };
      return { ...state, fleet: { ...state.fleet, [action.id]: entry } };
    }
    case 'fleetStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, status: 'running' as const, streamingText: '', startedAt: Date.now() },
        },
      };
    }
    case 'fleetDelta': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      // Keep only the last ~200 chars for display
      const appended = (cur.streamingText + action.text).slice(-200);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, streamingText: appended, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetTool': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, toolCalls: cur.toolCalls + 1, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetUsage': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      // Compute cost delta from raw token counts using a simplified pricing
      // model. The actual per-model pricing is applied by FleetUsageAggregator;
      // here we approximate as a live display hint.
      const cost = cur.cost;
      return {
        ...state,
        fleet: { ...state.fleet, [action.id]: { ...cur, cost, lastEventAt: Date.now() } },
      };
    }
    case 'fleetDone': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: action.status,
            iterations: action.iterations,
            toolCalls: action.toolCalls,
            streamingText: '',
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetCost': {
      return { ...state, fleetCost: action.cost };
    }
    case 'setStreamFleet': {
      return { ...state, streamFleet: action.enabled };
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
  queueStore,
  yolo = false,
  appVersion,
  provider,
  family,
  keyTail,
  getPickableProviders,
  switchProviderAndModel,
  effectiveMaxContext,
  onExit,
  director,
  fleetRoster,
  onClearHistory,
  fleetStreamController,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  // Reactive mirrors of agent.ctx.{model,provider.id} so the status bar
  // re-renders when /model or /use mutate them. The banner is `Static`
  // and never re-renders — the user gets the textual confirmation from
  // the slash command's message in history instead.
  const [liveModel, setLiveModel] = useState<string>(model);
  const [liveProvider, setLiveProvider] = useState<string>(provider ?? 'agent');
  const [state, dispatch] = useReducer(reducer, {
    entries: banner
      ? [
          {
            id: 0,
            kind: 'banner' as const,
            version: appVersion ?? 'dev',
            provider: provider ?? 'agent',
            model,
            cwd: agent.ctx.cwd,
            family,
            keyTail,
          },
        ]
      : [],
    buffer: '',
    cursor: 0,
    placeholders: [],
    streamingText: '',
    toolStream: null,
    status: 'idle' as const,
    interrupts: 0,
    hint: '',
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider' as const,
      providerOptions: [],
      modelOptions: [],
      selected: 0,
    },
    confirm: null,
    contextChipVersion: 0,
    fleet: {},
    fleetCost: 0,
    streamFleet: true,
  });

  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  const activeCtrlRef = useRef<AbortController | null>(null);
  // Prevent re-entrant handleKey: some terminals emit \r\n as two separate
  // stdin events for Enter. While the first event is being processed (submit
  // or picker accept), the second arrives with stale state and would trigger
  // a duplicate action. The gate blocks the stale-second event entirely.
  const inputGateRef = useRef(false);
  // Separate guard JUST for the submit path. The full `inputGateRef`
  // is held across `await foo()` blocks (picker accept, model picker
  // commit) — that's fine because those resolve in milliseconds. But
  // `await submit()` resolves only when `agent.run()` finishes, which
  // can be minutes for a delegated subagent task. Using the same gate
  // would lock ALL keystrokes (typing, backspace, slash menu) for the
  // entire agent run. This timestamp-based guard fires for the few
  // milliseconds needed to debounce a terminal-side `\r\n` double-event
  // and then auto-releases — leaving the input live for the user.
  const lastEnterAtRef = useRef(0);
  const projectRoot = agent.ctx.projectRoot;
  // The status-bar chip surfaces the basename so multiple WrongStack
  // windows running against different repos are immediately distinguishable.
  // Empty / root fallback to undefined so the chip just hides itself.
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  // Source of truth for the streamed assistant text — kept here, not in
  // React state, because we need to read it synchronously when `agent.run`
  // returns. The React `streamingText` shown in the live tail is throttled
  // (~10fps) for redraw cost, so it can lag the actual stream by up to
  // FLUSH_MS. Reading from this ref instead removes the race where the
  // final chunk lands in pending after run() returns and ends up flashing
  // into the next frame's tail (leaking into scrollback).
  const streamingTextRef = useRef('');
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest state snapshot — async callbacks (the queue drainer, slash command
  // closures) read this instead of capturing `state` to avoid stale closures.
  const stateRef = useRef<State>(state);
  stateRef.current = state;

  // Session-elapsed clock. Mount time is fixed; we re-render once per
  // second to refresh the "⏱ 12:34" chip. The interval is cheap — one
  // dispatch per tick into the same `tick` action — and stops cleanly
  // on unmount.
  const startedAtRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = React.useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedMs = nowTick - startedAtRef.current;

  // Git branch + change counts. Polled every 5s (cheap, two short-lived
  // `git` subprocesses). Skipped silently when the cwd isn't a repo or
  // git isn't installed — the chip just doesn't render.
  const [gitInfo, setGitInfo] = React.useState<GitInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readGitInfo(agent.ctx.cwd)
        .then((info) => {
          if (!cancelled) setGitInfo(info);
        })
        .catch(() => undefined);
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agent.ctx.cwd]);

  // Latest provider request's input-token count. Tracked separately
  // from `tokenCounter` (which is cumulative) because for the context
  // fullness bar we want the live size of the conversation as it sat
  // on the wire — that's what determines how close we are to the
  // model's max context window.
  //
  // We sum input + cacheRead + cacheWrite so the chip reflects the TRUE
  // total context the model loaded (Usage is disjoint by design — see the
  // doc on Usage). Without this, prompt-cached turns would show only the
  // fresh-token delta and the chip would read 0% even when the context
  // was near the limit.
  const [lastInputTokens, setLastInputTokens] = React.useState<number>(0);
  useEffect(() => {
    const off = events.on('provider.response', (e) => {
      const total =
        (e.usage.input ?? 0) + (e.usage.cacheRead ?? 0) + (e.usage.cacheWrite ?? 0);
      setLastInputTokens(total);
    });
    return () => {
      off();
    };
  }, [events]);

  // Prefer the CLI-resolved per-model maxContext (looks up the active
  // model in the ModelsRegistry, so 1M-context variants report 1M rather
  // than the provider family's 200k baseline). Fall back to the provider
  // baseline when the CLI couldn't resolve it (e.g. unknown model id).
  const maxContext = effectiveMaxContext ?? agent.ctx.provider.capabilities.maxContext;
  const contextWindow = useMemo(() => {
    void state.contextChipVersion;
    return lastInputTokens > 0 && maxContext > 0
      ? { used: lastInputTokens, max: maxContext }
      : undefined;
  }, [lastInputTokens, maxContext, state.contextChipVersion]);

  // Todo counts come from the agent's context, which is mutated by
  // the `todo` tool. Re-read on each render — array access is O(N) on
  // a list that's typically < 20 items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nowTick intentionally triggers re-render; ctx.todos is not React state
  const todos = useMemo(() => {
    const counts = { pending: 0, inProgress: 0, completed: 0 };
    for (const t of agent.ctx.todos) {
      if (t.status === 'pending') counts.pending++;
      else if (t.status === 'in_progress') counts.inProgress++;
      else if (t.status === 'completed') counts.completed++;
    }
    return counts;
    // Tick on `nowTick` so we pick up todo changes even though
    // agent.ctx.todos isn't React state — the 1s clock doubles as a
    // poll for ctx-side state.
  }, [nowTick, agent.ctx.todos]);

  // Fleet breakdown for the status-bar chip. Derived from `state.fleet`,
  // which the FleetBus event listeners already maintain — re-bucket
  // into running / idle / pending / completed because that's the slice
  // the user cares about at a glance. Recomputes on every state.fleet
  // change (cheap — fleet usually has <10 entries).
  const fleetCounts = useMemo(() => {
    const entries = Object.values(state.fleet);
    if (entries.length === 0) return undefined;
    let running = 0;
    let idle = 0;
    let completed = 0;
    for (const e of entries) {
      if (e.status === 'running') running += 1;
      else if (e.status === 'idle') idle += 1;
      else completed += 1; // success/failed/timeout/stopped all count as "done"
    }
    return { running, idle, pending: 0, completed };
  }, [state.fleet]);

  // Per-agent detail for the status bar's optional 4th line. Limited to
  // the top 4 active agents (running first, then idle) sorted by spawn
  // order so the bar doesn't wrap on wide fleets. Reuses the global
  // `nowTick` (bumped every 1s above) so elapsed time keeps ticking
  // without needing a second timer.
  const fleetAgents = useMemo(() => {
    const entries = Object.entries(state.fleet);
    if (entries.length === 0) return undefined;
    // Show running first, then idle. Completed/failed agents drop off
    // the active line — they're already reflected in the aggregate ✓N
    // counter on line 3.
    const active = entries.filter(([_id, e]) => e.status === 'running' || e.status === 'idle');
    if (active.length === 0) return undefined;
    active.sort((a, b) => {
      const sa = a[1].status === 'running' ? 0 : 1;
      const sb = b[1].status === 'running' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a[1].startedAt - b[1].startedAt;
    });
    return active.slice(0, 4).map(([id, e]) => {
      const lbl = labelFor(id, e.name);
      return {
        label: lbl.label,
        color: lbl.color,
        elapsedMs: Math.max(0, nowTick - e.startedAt),
        toolCalls: e.toolCalls,
        running: e.status === 'running',
      };
    });
  }, [state.fleet, nowTick]);

  // Plan counts come from `<sessionId>.plan.json` on disk, not React
  // state. We poll lazily every few ticks so the chip stays current
  // without slamming the FS — plans change at human pace (a few times
  // per session at most), so 3s granularity is plenty.
  const [planCounts, setPlanCounts] = useState<{
    open: number;
    inProgress: number;
    done: number;
  } | null>(null);
  useEffect(() => {
    const planPath = (agent.ctx.meta as Record<string, unknown>)['plan.path'];
    if (typeof planPath !== 'string' || !planPath) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fs.readFile(planPath, 'utf8');
        const parsed = JSON.parse(data) as {
          items?: Array<{ status?: string }>;
        };
        if (cancelled) return;
        if (!Array.isArray(parsed.items)) {
          setPlanCounts(null);
          return;
        }
        let open = 0;
        let inProgress = 0;
        let done = 0;
        for (const it of parsed.items) {
          if (it?.status === 'done') done++;
          else if (it?.status === 'in_progress') inProgress++;
          else open++;
        }
        setPlanCounts(open + inProgress + done > 0 ? { open, inProgress, done } : null);
      } catch {
        // Missing or corrupt — clear the chip.
        if (!cancelled) setPlanCounts(null);
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agent.ctx.meta]);

  // Live-region shrink mitigation. Ink's log-update tracks the previous
  // render's logical line count; when content visually wraps past the
  // terminal width, the visual-row count exceeds the logical count and
  // log-update's clear-and-rewrite leaves the extra visual rows behind.
  // Those extras then slide into native scrollback as the next render
  // commits new Static items above the live region — looking to the user
  // like an extra echo of the input ("Enter ile boş input da history'e
  // sıyrılıyor").
  //
  // We can't reach log-update directly, but we can issue an erase-below-
  // cursor (\x1b[J) at the moments most likely to leak: when a picker /
  // dialog transitions from open → closed (the live region's height
  // drops sharply), and when a fresh history entry was just committed.
  // \x1b[J only touches what's below the cursor, so committed Static
  // history above is preserved. For users in heavy resize / picker
  // workflows the bullet-proof alternative is still `--alt-screen`.
  const prevAnyOverlayOpen = useRef(false);
  const prevEntriesCount = useRef(0);
  useEffect(() => {
    const anyOpenNow =
      state.picker.open ||
      state.slashPicker.open ||
      state.modelPicker.open ||
      !!state.confirm;
    const overlayClosed = prevAnyOverlayOpen.current && !anyOpenNow;
    const newEntryCommitted = state.entries.length > prevEntriesCount.current;
    prevAnyOverlayOpen.current = anyOpenNow;
    prevEntriesCount.current = state.entries.length;
    if (overlayClosed || newEntryCommitted) {
      try {
        process.stdout.write('\x1b[J');
      } catch {
        // stdout might be detached during shutdown — ignore.
      }
    }
  }, [
    state.picker.open,
    state.slashPicker.open,
    state.modelPicker.open,
    state.confirm,
    state.entries.length,
  ]);

  // Detect an active `@<query>` token at the cursor and drive the picker.
  // Reruns whenever buffer/cursor changes — guards against stale results.
  // biome-ignore lint/correctness/useExhaustiveDependencies: picker state reads are intentional — dispatching based on stale picker state is harmless
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

  // Detect an active `/<query>` token at the cursor and drive the slash picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashPicker state reads are intentional — same pattern as @ picker above
  useEffect(() => {
    const trimmed = state.buffer.trimStart();
    if (!trimmed.startsWith('/')) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    // Once any whitespace appears after the leading '/', the user has moved
    // past the command name into argument territory (e.g. `/model glm-5.1`).
    // Keeping the picker open here is actively harmful: Enter would route to
    // acceptSlashPickerSelection() and overwrite the typed args with just
    // `/<cmd> `. Close the picker so Enter submits the full line.
    if (/\s/.test(trimmed)) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    const query = trimmed.slice(1).toLowerCase();
    const allCommands = slashRegistry.listWithOwner();
    const matches: SlashCommandMatch[] = allCommands
      .filter(({ cmd }) => {
        const name = cmd.name.toLowerCase();
        const aliases = cmd.aliases ?? [];
        return name.includes(query) || aliases.some((a) => a.toLowerCase().includes(query));
      })
      .slice(0, 12)
      .map(({ cmd, owner }) => ({
        name: cmd.name,
        description: cmd.description,
        argsHint: undefined as string | undefined,
        isBuiltin: owner === 'core',
      }));

    if (!state.slashPicker.open) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    } else if (state.slashPicker.query !== query) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, slashRegistry]);

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
        entry: {
          kind: 'error',
          text: `Attach failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      dispatch({ type: 'pickerClose' });
    }
  };

  /** Fill the buffer with the selected slash command and close the picker. */
  const acceptSlashPickerSelection = (): void => {
    const { open, matches, selected } = state.slashPicker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const cmd = picked.argsHint !== undefined ? `/${picked.name} ` : `/${picked.name}`;
    dispatch({ type: 'setBuffer', buffer: cmd, cursor: cmd.length });
    dispatch({ type: 'slashPickerClose' });
  };

  // Rehydrate any queue items persisted by a previous (crashed) run.
  // Fires once at mount; the persist effect below picks up afterwards.
  // We dispatch one enqueue per item so the reducer's id allocation
  // stays the single source of truth — no need to import its internals.
  useEffect(() => {
    if (!queueStore) return;
    let cancelled = false;
    queueStore
      .read()
      .then((items) => {
        if (cancelled || items.length === 0) return;
        for (const item of items) {
          dispatch({
            type: 'enqueue',
            item: { displayText: item.displayText, blocks: item.blocks },
          });
        }
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Restored ${items.length} queued message${items.length === 1 ? '' : 's'} from a previous run.`,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // Persist the queue snapshot on every change. Strip the in-memory id
  // before writing — it's render bookkeeping, not part of the message.
  // Errors are swallowed: the queue lives in memory regardless, so a
  // persistence failure only loses crash-recovery, not the queue itself.
  useEffect(() => {
    if (!queueStore) return;
    queueStore
      .write(state.queue.map(({ displayText, blocks }) => ({ displayText, blocks })))
      .catch(() => undefined);
  }, [state.queue, queueStore]);

  // Register the TUI-only /queue command for the lifetime of this App.
  useEffect(() => {
    const cmd = createQueueSlashCommand({
      getQueue: () => stateRef.current.queue,
      clear: () => dispatch({ type: 'queueClear' }),
      deleteAt: (positions) => dispatch({ type: 'queueDelete', positions }),
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry]);

  // Register `/altscreen on|off` — runtime escape valve for the
  // alt-screen scrollback limitation. In alt-screen mode the terminal's
  // native scrollback is disabled, so users can't review old chat
  // entries. `off` writes the alt-screen-exit escape so subsequent
  // entries land in the normal scroll region and the mouse wheel /
  // shift+pgup work again. The trade-off (lost on-screen history,
  // resize artifacts) is spelled out in the response message so the
  // user can decide whether to keep it.
  useEffect(() => {
    const ALT_OFF = '\x1b[?1049l';
    const ALT_ON = '\x1b[?1049h';
    const cmd = {
      name: 'altscreen',
      description: 'Toggle the alt-screen buffer. Default is OFF (native scroll); /altscreen on for full-screen mode.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (arg === 'off') {
          try {
            process.stdout.write(ALT_OFF);
          } catch {
            return { message: 'Failed to exit alt-screen.' };
          }
          return {
            message:
              'Alt-screen disabled. New entries will land in normal scrollback (mouse wheel / Shift+PgUp work). ' +
              'On-screen history rendered before this command is no longer reachable via terminal scroll. ' +
              'Resize may now leak the live region — `/altscreen on` to re-enable.',
          };
        }
        if (arg === 'on') {
          try {
            process.stdout.write(ALT_ON);
          } catch {
            return { message: 'Failed to re-enter alt-screen.' };
          }
          return { message: 'Alt-screen re-enabled. Native scroll is now disabled.' };
        }
        return { message: 'Usage: /altscreen on|off' };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('altscreen');
    };
  }, [slashRegistry]);

  // Register the TUI-only `/model` command — opens a two-step picker
  // (provider → model). All work is local state mutation; the actual
  // switch fires only after the user confirms a model in step 2.
  useEffect(() => {
    if (!getPickableProviders || !switchProviderAndModel) return;
    const cmd = {
      name: 'model',
      aliases: ['provider', 'switch'],
      description: 'Pick a provider + model interactively (two-step).',
      async run() {
        const providers = await getPickableProviders();
        dispatch({ type: 'modelPickerOpen', providers });
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('model');
    };
  }, [slashRegistry, getPickableProviders, switchProviderAndModel]);

  // Subscribe to provider streaming events.
  useEffect(() => {
    // Throttle stream delta DISPATCHES to reduce flicker — we batch into
    // React state at ~10fps. The full text is also written into
    // streamingTextRef synchronously on every delta, so `runBlocks` can
    // read the complete stream when `agent.run` returns without racing
    // the throttle's last unflushed batch.
    const FLUSH_MS = 100;
    const flush = () => {
      if (pendingDeltaRef.current) {
        dispatch({ type: 'streamDelta', delta: pendingDeltaRef.current });
        pendingDeltaRef.current = '';
      }
      flushTimerRef.current = null;
    };
    const offDelta = events.on('provider.text_delta', (e) => {
      // Strip any bracketed-paste DCS sequences that some providers echo
      // into the stream. They are invisible in a real terminal but appear as
      // junk text if Ink's raw rendering catches them.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: bracketed paste escape sequences are intentional
      const text = e.text.replace(/\x1b\[200~|\x1b\[201~/g, '');
      streamingTextRef.current += text;
      pendingDeltaRef.current += text;
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    });
    const offToolStart = events.on('tool.started', (e) => {
      dispatch({ type: 'toolStarted', id: e.id, name: e.name });
    });
    const offToolProgress = events.on('tool.progress', (e) => {
      // Only `partial_output` becomes the live tail. Other event kinds
      // (`log`, `warning`, `metric`, `file_changed`) are deliberately not
      // rendered here — they pile up too fast and would steal screen real
      // estate from the assistant text. They still flow through EventBus
      // for observability/metrics consumers.
      if (e.event.type !== 'partial_output' || !e.event.text) return;
      dispatch({
        type: 'toolStreamAppend',
        toolUseId: e.id,
        name: e.name,
        text: e.event.text,
        startedAt: Date.now(),
      });
    });
    const offTool = events.on('tool.executed', (e) => {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'tool',
          name: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
          input: e.input,
          output: e.output,
          // Real model-visible sizes — forwarded so the size chip beside
          // the tool header can show what the model paid for instead of
          // the misleading preview-byte count we used to surface.
          outputBytes: e.outputBytes,
          outputTokens: e.outputTokens,
          outputLines: e.outputLines,
        },
      });
      // `tool.executed` has no tool_use id; the reducer falls back to
      // clearing the oldest running entry that matches this name.
      dispatch({ type: 'toolEnded', name: e.name });
      // Clear the live tail for this tool — the final entry is now in
      // <Static>, no need to keep mirroring it below.
      dispatch({ type: 'toolStreamClear', name: e.name });
      // Echo the current todo list into chat whenever the `todo` tool
      // mutates ctx.todos — same format as `/todos list`. Snapshotted from
      // agent.ctx.todos at this point (the tool executor has already
      // applied the mutation by the time tool.executed fires).
      if (e.ok && e.name === 'todo') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: formatTodosList(agent.ctx.todos) },
        });
      }
    });
    const offRetry = events.on('provider.retry', (e) => {
      const secs = (e.delayMs / 1000).toFixed(e.delayMs >= 1000 ? 1 : 2);
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `⟳ retry ${e.attempt} in ${secs}s — ${e.description}` },
      });
    });
    const offProvErr = events.on('provider.error', (e) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: e.description },
      });
    });
    // Per-iteration text flush. Without this, the entire run buffers all text
    // deltas in the live tail box and dumps them into history as ONE assistant
    // entry only after `agent.run()` returns. Tool results, in contrast, land
    // in history immediately via `tool.executed` — so a multi-iteration turn
    // renders as "all tools, then a wall of text" instead of the natural
    // text → tool → text → tool interleaving that matches the actual stream.
    //
    // We hook `provider.response` (fires once per LLM call, both for
    // intermediate `tool_use` stops and the final `end_turn`) and commit
    // whatever has accumulated in `streamingTextRef` as an assistant history
    // entry. The next iteration's deltas start a fresh buffer. `runBlocks`
    // becomes purely the loop driver — it no longer adds the assistant entry,
    // since the per-iteration flushes have already done so.
    const offProvResp = events.on('provider.response', () => {
      const text = streamingTextRef.current;
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });
      if (text.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text } });
      }
    });
    const offConfirmNeeded = events.on('tool.confirm_needed', (e) => {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'confirm',
          toolName: e.tool.name,
          input: e.input,
          suggestedPattern: e.suggestedPattern,
        },
      });
      dispatch({
        type: 'confirmOpen',
        info: {
          toolUseId: e.toolUseId,
          toolName: e.tool.name,
          input: e.input,
          suggestedPattern: e.suggestedPattern,
          resolve: e.resolve,
        },
      });
    });
    return () => {
      offDelta();
      offToolStart();
      offToolProgress();
      offTool();
      offRetry();
      offProvErr();
      offProvResp();
      offConfirmNeeded();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [events, agent.ctx.todos]);

  // Stable per-subagent label + color, assigned on first sighting and
  // shared between the FleetBus listener (history stream) and the
  // fleetAgents memo (status bar 4th line). Stored in a ref so a label
  // assigned during one render is visible to the next render's memo
  // without forcing a separate state update for the side table.
  const STREAM_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];
  const labelsRef = useRef<Map<string, { label: string; color: string }>>(new Map());
  const labelFor = (id: string, name?: string): { label: string; color: string } => {
    const m = labelsRef.current;
    const existing = m.get(id);
    if (existing) return existing;
    const n = m.size + 1;
    const suffix = name && name !== id ? ` ${name}` : '';
    const v = { label: `AGENT#${n}${suffix}`, color: STREAM_COLORS[(n - 1) % STREAM_COLORS.length]! };
    m.set(id, v);
    return v;
  };

  // Live mirror of `streamFleet` for the FleetBus listener below. The
  // listener is wired in a single mount-time effect so it doesn't tear
  // down per-state-change; a ref lets it read the current toggle value
  // on every event without re-subscribing.
  const streamFleetRef = useRef(state.streamFleet);
  useEffect(() => {
    streamFleetRef.current = state.streamFleet;
  }, [state.streamFleet]);

  // --- Subagent lifecycle entries (uniform for director + non-director) ---
  // Wired to EventBus, not FleetBus, so /spawn-agent runs (which don't
  // build a Director) also surface in the chat. The director path emits
  // the same events through `MultiAgentHost`, so this single listener
  // covers both modes and replaces the per-status history entry that
  // previously lived inside the director.on('task.completed') hook.
  useEffect(() => {
    const offSpawned = events.on('subagent.spawned', (e) => {
      const lbl = labelFor(e.subagentId, e.name);
      dispatch({
        type: 'fleetSpawn',
        id: e.subagentId,
        name: e.name,
        provider: e.provider,
        model: e.model,
      });
      const where = e.provider && e.model ? `${e.provider}/${e.model}` : 'spawned';
      const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: lbl.label,
          agentColor: lbl.color,
          icon: '▶',
          text: `${where}${desc}`,
        },
      });
    });
    const offStarted = events.on('subagent.task_started', (e) => {
      const lbl = labelFor(e.subagentId);
      dispatch({ type: 'fleetStart', id: e.subagentId, taskId: e.taskId });
      const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: lbl.label,
          agentColor: lbl.color,
          icon: '●',
          text: `task started${desc}`,
        },
      });
    });
    const offCompleted = events.on('subagent.task_completed', (e) => {
      const lbl = labelFor(e.subagentId);
      dispatch({
        type: 'fleetDone',
        id: e.subagentId,
        status: e.status,
        iterations: e.iterations,
        toolCalls: e.toolCalls,
      });
      // Status-specific icon so timeout/stopped/failed are visually
      // distinct from a plain success. We now have a structured error
      // envelope with `kind` (e.g. `provider_rate_limit`,
      // `tool_failed`) — prefix the tail with `[kind]` so the user
      // sees the actual failure mode, not just "✗ failed" for every
      // breed of failure.
      const icon =
        e.status === 'success'
          ? '✓'
          : e.status === 'timeout'
            ? '⏱'
            : e.status === 'stopped'
              ? '⊘'
              : '✗';
      const errKind = e.error?.kind;
      const errMsg = e.error?.message;
      const errMsgTail = errMsg
        ? ` — ${errMsg.replace(/\s+/g, ' ').slice(0, 100)}${errMsg.length > 100 ? '…' : ''}`
        : '';
      const errChip = errKind ? ` [${errKind}]` : '';
      const secs = (e.durationMs / 1000).toFixed(e.durationMs < 10_000 ? 1 : 0);
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: lbl.label,
          agentColor: lbl.color,
          icon,
          text: `${e.status} (${e.iterations} iter · ${e.toolCalls} tools · ${secs}s)${errChip}${errMsgTail}`,
        },
      });
    });
    return () => {
      offSpawned();
      offStarted();
      offCompleted();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Install a dispatch-backed setter into the shared controller so the
  // `/fleet stream on|off` slash command can flip our reducer flag.
  // Restored to a noop on unmount so a late-arriving slash callback
  // doesn't dispatch into a torn-down React tree.
  useEffect(() => {
    if (!fleetStreamController) return;
    fleetStreamController.enabled = state.streamFleet;
    fleetStreamController.setEnabled = (enabled: boolean) => {
      dispatch({ type: 'setStreamFleet', enabled });
    };
    return () => {
      fleetStreamController.setEnabled = (enabled: boolean) => {
        fleetStreamController.enabled = enabled;
      };
    };
  }, [fleetStreamController, state.streamFleet]);

  // Keep the controller's mirror of `enabled` in sync when the toggle is
  // flipped from a TUI-side path (not the slash command).
  useEffect(() => {
    if (fleetStreamController) fleetStreamController.enabled = state.streamFleet;
  }, [state.streamFleet, fleetStreamController]);

  // --- FleetBus → TUI dispatch bridge ---
  // Subscribes to every event on the director's FleetBus and dispatches
  // fleet state actions. Text deltas are throttled (FLUSH_MS) to avoid
  // flooding React re-renders; other events dispatch immediately.
  // Seeds initial fleet state from director.status() on mount so the
  // panel reflects subagents spawned before the TUI attached.
  // biome-ignore lint/correctness/useExhaustiveDependencies: labelFor is ref-stable
  useEffect(() => {
    const d = director;
    if (!d) return;
    const FLUSH_MS = 150;

    // Per-agent buffered assistant text. Flushed as one `subagent`
    // history entry when the agent stops emitting deltas for FLUSH_MS,
    // so we don't fire a fresh history entry on every token.
    const streamBuf = new Map<string, string>();
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStreamBufs = () => {
      for (const [id, text] of streamBuf) {
        if (!text.trim()) continue;
        const lbl = labelFor(id);
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: lbl.label,
            agentColor: lbl.color,
            icon: '💬',
            text: text.trim(),
          },
        });
      }
      streamBuf.clear();
      streamFlushTimer = null;
    };

    // Seed: discover already-spawned subagents from the coordinator.
    const status = d.status();
    for (const s of status.subagents) {
      const meta = d.getSubagentMeta(s.id);
      dispatch({
        type: 'fleetSpawn',
        id: s.id,
        name: meta?.name ?? s.name,
        provider: meta?.provider,
        model: meta?.model,
      });
      // Seed a stable label so subagents spawned before TUI mount still
      // show up by name in the status bar's per-agent detail line.
      labelFor(s.id, meta?.name ?? s.name);
    }
    // Also seed cost from the usage aggregator.
    dispatch({ type: 'fleetCost', cost: d.snapshot().total.cost });

    // Discover new subagents on first FleetBus event for an unknown id.
    const seen = new Set(Object.keys(status.subagents));

    // Throttled delta accumulator per subagent.
    const pending = new Map<string, string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const doFlush = () => {
      for (const [id, text] of pending) {
        if (text) dispatch({ type: 'fleetDelta', id, text });
      }
      pending.clear();
      flushTimer = null;
    };

    const offFleet = d.fleet.onAny((e: FleetEvent) => {
      // Discover new subagents.
      const fresh = !seen.has(e.subagentId);
      if (fresh) {
        seen.add(e.subagentId);
        const meta = d.getSubagentMeta(e.subagentId);
        dispatch({ type: 'fleetSpawn', id: e.subagentId, name: meta?.name, provider: meta?.provider, model: meta?.model });
        // Always assign a label on first sighting so the status bar's
        // 4th line has stable AGENT#N names even when history streaming
        // is disabled. The history `spawned` entry below is gated on
        // streamFleet; label assignment itself is unconditional.
        const lbl = labelFor(e.subagentId, meta?.name);
        if (streamFleetRef.current) {
          const where = meta?.provider && meta?.model ? `${meta.provider}/${meta.model}` : 'spawned';
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'subagent',
              agentLabel: lbl.label,
              agentColor: lbl.color,
              icon: '▶',
              text: where,
            },
          });
        }
      }

      switch (e.type) {
        case 'iteration.started':
          dispatch({ type: 'fleetStart', id: e.subagentId });
          break;
        case 'provider.text_delta': {
          const p = e.payload as { text?: string };
          if (p?.text) {
            const cur = pending.get(e.subagentId) ?? '';
            pending.set(e.subagentId, cur + p.text);
            if (!flushTimer) flushTimer = setTimeout(doFlush, FLUSH_MS);
            if (streamFleetRef.current) {
              streamBuf.set(e.subagentId, (streamBuf.get(e.subagentId) ?? '') + p.text);
              if (!streamFlushTimer) streamFlushTimer = setTimeout(flushStreamBufs, FLUSH_MS * 4);
            }
          }
          break;
        }
        case 'tool.executed': {
          dispatch({ type: 'fleetTool', id: e.subagentId });
          if (streamFleetRef.current) {
            // Flush any pending assistant text so tool calls appear in
            // order relative to the chat that produced them.
            if (streamFlushTimer) {
              clearTimeout(streamFlushTimer);
              flushStreamBufs();
            }
            const p = e.payload as { name?: string; ok?: boolean; durationMs?: number; input?: unknown };
            const args = p?.input ? formatToolArgs(p.name ?? '', p.input) : '';
            const lbl = labelFor(e.subagentId);
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'subagent',
                agentLabel: lbl.label,
                agentColor: lbl.color,
                icon: p?.ok === false ? '✗' : '●',
                text: args ? `${p?.name ?? 'tool'} ${args}` : (p?.name ?? 'tool'),
                detail: typeof p?.durationMs === 'number' ? `${p.durationMs}ms` : undefined,
              },
            });
          }
          break;
        }
        case 'provider.response': {
          // Surface live cost from the aggregator (already computed with
          // per-model pricing). The fleetUsage reducer case is a stub that
          // preserves cost; fleetCost carries the real value.
          dispatch({ type: 'fleetCost', cost: d.snapshot().total.cost });
          break;
        }
        case 'session.ended':
          // Subagent finished — leave status update to task.completed.
          break;
      }
    });

    // Task completions arrive on the director's bus too, but the
    // history entry is now produced by the `subagent.task_completed`
    // EventBus listener (which fires uniformly for director and
    // non-director paths). Here we only update fleet panel state +
    // running cost — the chat-side entry would otherwise duplicate.
    const offDone = d.on('task.completed', (payload) => {
      dispatch({
        type: 'fleetDone',
        id: payload.result.subagentId,
        status: payload.result.status,
        iterations: payload.result.iterations,
        toolCalls: payload.result.toolCalls,
      });
      dispatch({ type: 'fleetCost', cost: d.snapshot().total.cost });
      // Drain any pending streaming text right before the completion
      // entry is committed by the EventBus listener so the order
      // "chat → done line" stays correct.
      if (streamFleetRef.current && streamFlushTimer) {
        clearTimeout(streamFlushTimer);
        flushStreamBufs();
      }
    });

    return () => {
      offFleet();
      offDone();
      if (flushTimer) clearTimeout(flushTimer);
      doFlush(); // commit any pending deltas before cleanup
      if (streamFlushTimer) clearTimeout(streamFlushTimer);
      flushStreamBufs();
    };
  }, [director]);

  // Handle SIGINT: first cancels current iteration + kills the fleet,
  // second forces exit regardless of state (the old `status === 'idle'`
  // gate left users stuck in 'aborting' forever when a delegate call
  // wouldn't unwind — agent.run() doesn't return while subagents
  // ignore the abort signal). Third press hard-kills via process.exit
  // so a wedged Ink loop can't trap the user.
  useEffect(() => {
    const onSigint = () => {
      // Second (or later) Ctrl+C — exit no matter what. Status may be
      // 'aborting', 'running', or 'streaming'; the user has clearly
      // decided they want out. Try Ink's graceful exit first, then
      // hard-exit on a short timer in case the React tree is wedged.
      if (state.interrupts >= 1) {
        // Third press = hard kill, no waiting.
        if (state.interrupts >= 2) {
          process.exit(130);
        }
        try {
          exit();
          onExit(130);
        } catch {
          // ignore
        }
        // Safety net: if Ink's waitUntilExit doesn't resolve within
        // 500ms (a stuck delegate await, an unhandled promise), force
        // exit so the user actually gets their shell back.
        setTimeout(() => {
          try {
            process.exit(130);
          } catch {
            // ignore
          }
        }, 500).unref?.();
        dispatch({ type: 'interrupt' });
        return;
      }
      dispatch({ type: 'interrupt' });
      if (activeCtrlRef.current) {
        activeCtrlRef.current.abort();
        dispatch({ type: 'status', status: 'aborting' });
        // Kill every running subagent on the first interrupt — without
        // this the parent agent.run() stays parked in `await delegate
        // → director.awaitTasks` forever and the "press again to exit"
        // hint becomes a lie. terminateAll is fire-and-forget so a slow
        // shutdown doesn't block the SIGINT handler.
        if (director) {
          void director.terminateAll().catch(() => undefined);
        }
        const droppedCount = stateRef.current.queue.length;
        if (droppedCount > 0) {
          dispatch({ type: 'queueClear' });
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}. Dropped ${droppedCount} queued message${droppedCount === 1 ? '' : 's'}. Press Ctrl+C again to exit.`,
            },
          });
        } else {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}. Press Ctrl+C again to exit.`,
            },
          });
        }
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
  }, [state.interrupts, state.status, exit, onExit, director]);

  const handleKey = async (input: string, key: KeyEvent) => {
    // Note: we no longer block input while the agent is running. Enter
    // routes through the queue when busy (see submit()), but typing,
    // backspace, paste, and clipboard-image all stay live.
    if (state.status === 'aborting') return;

    // Re-entrancy guard: block stale-second events from \r\n terminals.
    if (inputGateRef.current) return;

    // Some terminals emit \r\n for Enter as two separate stdin events.
    // \r arrives with key.return=true (handled below); \n may arrive as
    // a stray character with key.return=false. Normalize both to Enter
    // and prevent them from polluting the buffer as literal text.
    const isEnter = key.return || input === '\r' || input === '\n';

    // IMPORTANT: do NOT bail on `!input` here. Special keys (arrows,
    // Enter, Escape, Tab, Backspace) arrive with an empty `input`
    // string, and the slash/file pickers + cursor movement below all
    // depend on receiving those events. The late guard before text
    // insertion handles the empty-input case correctly.

    // Model picker takes absolute precedence: nothing else is meaningful
    // while the two-step overlay is open. Esc cancels (or backs out of
    // step 2 to step 1); Enter advances to the next step or confirms.
    if (state.modelPicker.open) {
      if (key.escape) {
        if (state.modelPicker.step === 'model') {
          dispatch({ type: 'modelPickerBack' });
        } else {
          dispatch({ type: 'modelPickerClose' });
        }
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'modelPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'modelPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        inputGateRef.current = true;
        try {
          if (state.modelPicker.step === 'provider') {
          const opt = state.modelPicker.providerOptions[state.modelPicker.selected];
          if (!opt) return;
          dispatch({
            type: 'modelPickerPickProvider',
            providerId: opt.id,
            models: opt.models,
          });
          return;
        }
        // step === 'model' → commit the switch
        const providerId = state.modelPicker.pickedProviderId;
        const modelId = state.modelPicker.modelOptions[state.modelPicker.selected];
        if (!providerId || !modelId) return;
        const err = switchProviderAndModel?.(providerId, modelId);
        if (err) {
          dispatch({ type: 'modelPickerHint', text: err });
          return;
        }
        setLiveProvider(providerId);
        setLiveModel(modelId);
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: `Switched to ${providerId} / ${modelId}.` },
        });
        dispatch({ type: 'modelPickerClose' });
        return;
        } finally {
          inputGateRef.current = false;
        }
      }
      // Any other key while picker is open: ignore.
      return;
    }

    if (state.slashPicker.open) {
      if (key.escape) {
        dispatch({ type: 'slashPickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'slashPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'slashPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        inputGateRef.current = true;
        acceptSlashPickerSelection();
        inputGateRef.current = false;
        return;
      }
      // Tab → autocomplete with selected command
      if (key.tab && state.slashPicker.matches.length > 0) {
        const sel = state.slashPicker.matches[state.slashPicker.selected];
        if (sel) {
          dispatch({ type: 'setBuffer', buffer: `/${sel.name} `, cursor: sel.name.length + 2 });
          dispatch({ type: 'slashPickerClose' });
        }
        return;
      }
      // Any other key falls through to normal text handling.
    }

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
      if (isEnter) {
        inputGateRef.current = true;
        try {
          await acceptPickerSelection();
        } finally {
          inputGateRef.current = false;
        }
        return;
      }
      // Any other key falls through to normal text handling, which will
      // either extend the @-query (e.g. typing more chars) or break it
      // (e.g. typing a space) — handled below.
    }

    if (isEnter) {
      // Re-entrancy protection for terminals that emit `\r\n` as two
      // separate stdin events: ignore Enter pressed within 50ms of the
      // last one. The 50ms window catches the double-event reliably
      // (the second `\n` arrives within microseconds of the `\r`) while
      // staying well below human double-tap speed.
      //
      // We intentionally do NOT await submit() here — it kicks off
      // agent.run() which can stay pending for minutes when a delegate
      // call is in flight. Awaiting would block this handler frame for
      // the full duration, which means every subsequent keystroke would
      // miss its dispatch (including the slash key — the user reported
      // the input feeling dead during delegated work). submit() handles
      // its own re-entrancy via state.status: when the agent is busy,
      // the message is queued instead of re-running concurrently.
      const now = Date.now();
      if (now - lastEnterAtRef.current < 50) return;
      lastEnterAtRef.current = now;
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      if (key.ctrl) {
        const { cursor, buffer } = state;
        if (key.backspace) {
          if (cursor === 0) return;
          const beforeCursor = buffer.slice(0, cursor);
          const lastWordStart = beforeCursor.lastIndexOf(' ') + 1;
          const next = buffer.slice(0, lastWordStart) + buffer.slice(cursor);
          dispatch({ type: 'setBuffer', buffer: next, cursor: lastWordStart });
        } else {
          if (cursor >= buffer.length) return;
          const afterCursor = buffer.slice(cursor);
          const nextWordStart = afterCursor.indexOf(' ');
          const end = nextWordStart === -1 ? buffer.length : cursor + nextWordStart + 1;
          const next = buffer.slice(0, cursor) + buffer.slice(end);
          dispatch({ type: 'setBuffer', buffer: next, cursor });
        }
        return;
      }
      if (state.cursor === 0) return;
      const next = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor - 1 });
      return;
    }

    if (key.leftArrow) {
      if (key.ctrl) {
        const { cursor, buffer } = state;
        if (cursor === 0) return;
        const beforeCursor = buffer.slice(0, cursor);
        const prevWordStart = beforeCursor.lastIndexOf(' ');
        const target = prevWordStart === -1 ? 0 : prevWordStart + 1;
        dispatch({ type: 'setBuffer', buffer, cursor: target });
        return;
      }
      if (state.cursor > 0)
        dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.cursor - 1 });
      return;
    }
    if (key.rightArrow) {
      if (key.ctrl) {
        const { cursor, buffer } = state;
        if (cursor >= buffer.length) return;
        const afterCursor = buffer.slice(cursor);
        const nextWordStart = afterCursor.indexOf(' ');
        const target = nextWordStart === -1 ? buffer.length : cursor + nextWordStart + 1;
        dispatch({ type: 'setBuffer', buffer, cursor: target });
        return;
      }
      if (state.cursor < state.buffer.length)
        dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.cursor + 1 });
      return;
    }
    if (key.home) {
      dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: 0 });
      return;
    }
    if (key.end) {
      dispatch({ type: 'setBuffer', buffer: state.buffer, cursor: state.buffer.length });
      return;
    }

    // History scrolling is delegated to the terminal's native scrollback
    // (mouse wheel, Shift+PgUp in Windows Terminal, etc.) — Ink's <Static>
    // emits each finalized entry once and never repaints over it.
    if (key.upArrow) {
      if (state.inputHistory.length > 0) dispatch({ type: 'historyUp' });
      return;
    }
    if (key.downArrow) {
      if (state.historyIndex > 0) dispatch({ type: 'historyDown' });
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
    if (key.ctrl && input === 'w') {
      // Ctrl+W → delete word before cursor (same as Ctrl+Backspace).
      const { cursor, buffer } = state;
      if (cursor === 0) return;
      const beforeCursor = buffer.slice(0, cursor);
      const lastWordStart = beforeCursor.lastIndexOf(' ') + 1;
      const next = buffer.slice(0, lastWordStart) + buffer.slice(cursor);
      dispatch({ type: 'setBuffer', buffer: next, cursor: lastWordStart });
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
    let cleanInput = input;
    if (input.includes('\x1b[200~') || input.includes('\x1b[201~')) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: bracketed paste escape sequences are intentional
      cleanInput = input.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      bracketedPaste = true;
    }

    // Paste detection: chunks larger than threshold or containing a newline
    // are routed through InputBuilder instead of inserted character-by-char.
    if (bracketedPaste || cleanInput.length > PASTE_THRESHOLD_CHARS || cleanInput.includes('\n')) {
      const builder = builderRef.current;
      if (!builder) return;
      const ph = await builder.appendPaste(cleanInput);
      if (ph) {
        const lineCount = cleanInput.split('\n').length;
        dispatch({ type: 'addPlaceholder', ph: `${ph} (${lineCount} lines)` });
      } else {
        const next =
          state.buffer.slice(0, state.cursor) + cleanInput + state.buffer.slice(state.cursor);
        dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor + cleanInput.length });
      }
      return;
    }

    const next =
      state.buffer.slice(0, state.cursor) + cleanInput + state.buffer.slice(state.cursor);
    dispatch({ type: 'setBuffer', buffer: next, cursor: state.cursor + cleanInput.length });
  };

  /**
   * Drive a single iteration: run the agent against `blocks`, render the
   * result into history, then if any messages were typed while we were
   * busy, pull the head of the queue and recurse. Recursion terminates
   * when the queue is empty (status stays idle).
   */
  const runBlocks = async (blocks: ContentBlock[]): Promise<void> => {
    const ctrl = new AbortController();
    activeCtrlRef.current = ctrl;
    dispatch({ type: 'status', status: 'running' });

    try {
      const startedAt = Date.now();
      const before = tokenCounter?.total();
      const costBefore = tokenCounter?.estimateCost().total ?? 0;
      const result = await agent.run(blocks, { signal: ctrl.signal });

      // Per-iteration assistant text was already committed by the
      // `provider.response` listener as each LLM call finished. Safety net:
      // if anything is still lingering in the synchronous ref (e.g. an
      // aborted run that never received a final provider.response), commit
      // it now so partial output is preserved rather than silently dropped.
      const lingering = streamingTextRef.current;
      if (lingering.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text: lingering } });
      }
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });

      if (result.status === 'aborted') {
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: 'Aborted.' } });
      } else if (result.status === 'failed') {
        const err = result.error;
        const text = err
          ? `Failed [${err.severity}${err.recoverable ? ', recoverable' : ''}]: ${err.describe()}`
          : 'Failed.';
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text },
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

    // Drain the queue. If the run was aborted, the SIGINT handler has
    // already cleared the queue, so the head will be undefined.
    const head = stateRef.current.queue[0];
    if (head) {
      dispatch({ type: 'dequeueFirst' });
      await runBlocks(head.blocks);
    }
  };

  const submit = async () => {
    const raw = state.buffer;
    const trimmed = raw.trim();
    if (!trimmed && state.placeholders.length === 0) return;

    dispatch({ type: 'resetInterrupts' });

    // Slash commands always dispatch immediately, even mid-iteration —
    // they don't conflict with a running agent.
    if (trimmed.startsWith('/')) {
      dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed } });
      if (state.historyIndex > 0) dispatch({ type: 'historyPush', text: trimmed });
      dispatch({ type: 'clearInput' });
      try {
        const res = await slashRegistry.dispatch(trimmed, agent.ctx);
        if (res?.message) {
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        }
        // Slash commands like /model and /use mutate agent.ctx directly.
        // Re-sync the visible status bar so the user sees the switch
        // landed; otherwise the bar keeps the startup-time values and
        // /model "feels" broken even when subsequent requests use the
        // new model.
        const ctxModel = agent.ctx.model;
        if (ctxModel && ctxModel !== liveModel) setLiveModel(ctxModel);
        const ctxProviderId = (agent.ctx.provider as { id?: string } | undefined)?.id;
        if (ctxProviderId && ctxProviderId !== liveProvider) setLiveProvider(ctxProviderId);
        if (res?.exit) {
          exit();
          onExit(0);
        }
        // Only fire onClearHistory for `/clear` — without this gate every
        // slash command (`/model`, `/use`, `/help`, …) would wipe the
        // conversation. Match the command name segment, not just the
        // prefix, so `/clearfoo` doesn't trigger.
        const cmd = trimmed.slice(1).split(/\s+/, 1)[0];
        if (cmd === 'clear') {
          onClearHistory?.(dispatch);
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
    const displayText = trimmed || '(attachments only)';
    dispatch({ type: 'clearInput' });

    if (state.status !== 'idle') {
      // Agent is busy — queue this message for the drainer to pick up.
      dispatch({
        type: 'addEntry',
        entry: { kind: 'user', text: displayText, queued: true },
      });
      dispatch({ type: 'enqueue', item: { displayText, blocks } });
      if (state.historyIndex > 0) dispatch({ type: 'historyPush', text: trimmed });
      return;
    }

    dispatch({ type: 'addEntry', entry: { kind: 'user', text: displayText } });
    if (state.historyIndex > 0) dispatch({ type: 'historyPush', text: trimmed });
    await runBlocks(blocks);
  };

  const inputHint = useMemo(() => {
    if (state.status !== 'idle') return '';
    if (state.buffer.startsWith('/')) return 'slash command — Enter to dispatch';
    if (state.picker.open) return '';
    return '';
  }, [state.buffer, state.status, state.picker.open]);

  return (
    <Box flexDirection="column">
      <History
        entries={state.entries}
        streamingText={state.streamingText}
        toolStream={state.toolStream}
      />
      <Input
        value={state.buffer}
        cursor={state.cursor}
        placeholders={state.placeholders}
        disabled={state.status === 'aborting'}
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
      {state.slashPicker.open ? (
        <SlashMenu
          query={state.slashPicker.query}
          matches={state.slashPicker.matches}
          selected={state.slashPicker.selected}
        />
      ) : null}
      {state.modelPicker.open ? (
        <ModelPicker
          step={state.modelPicker.step}
          providerOptions={state.modelPicker.providerOptions}
          modelOptions={state.modelPicker.modelOptions}
          selected={state.modelPicker.selected}
          pickedProviderId={state.modelPicker.pickedProviderId}
          hint={state.modelPicker.hint}
        />
      ) : null}
      {state.confirm ? (
        <ConfirmPrompt
          toolName={state.confirm.toolName}
          input={state.confirm.input}
          suggestedPattern={state.confirm.suggestedPattern}
          onDecision={state.confirm.resolve}
        />
      ) : null}
      <StatusBar
        model={`${liveProvider}/${liveModel}`}
        state={state.status}
        tokenCounter={tokenCounter}
        hint={renderRunningTools(state.runningTools) || state.hint}
        queueCount={state.queue.length}
        yolo={yolo}
        elapsedMs={elapsedMs}
        todos={todos}
        plan={planCounts ?? undefined}
        fleet={fleetCounts}
        fleetAgents={fleetAgents}
        git={gitInfo}
        context={contextWindow}
        projectName={projectName}
        subagentCount={Object.keys(state.fleet).length}
      />
      {director ? (
        <FleetPanel
          entries={state.fleet}
          totalCost={state.fleetCost}
          roster={fleetRoster}
        />
      ) : null}
    </Box>
  );
}

/**
 * Render an at-a-glance "running: …" hint for the status bar. Shows the
 * oldest in-flight tool by name; if more than one, appends "(+N)".
 */
export function renderRunningTools(
  running: ReadonlyMap<string, { name: string; startedAt: number }>,
): string {
  if (running.size === 0) return '';
  let oldest: { name: string; startedAt: number } | null = null;
  for (const info of running.values()) {
    if (!oldest || info.startedAt < oldest.startedAt) oldest = info;
  }
  if (!oldest) return '';
  const elapsedSec = ((Date.now() - oldest.startedAt) / 1000).toFixed(1);
  const more = running.size > 1 ? ` (+${running.size - 1})` : '';
  return `running: ${oldest.name} ${elapsedSec}s${more}`;
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
