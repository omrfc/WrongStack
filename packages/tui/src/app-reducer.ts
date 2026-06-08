import { expectDefined } from '@wrongstack/core';
// Reducer — pure state transformation. Types are in app-state.ts.
// This file has NO React or Ink dependencies.
import type { HistoryEntry } from './components/history.js';
import type { WorktreeRow } from './components/worktree-panel.js';

import {
  AUDIT_LEVELS,
  COMPACTOR_STRATEGIES,
  DELAY_PRESETS_MS,
  LOG_LEVELS,
  MAX_ITERATIONS_PRESETS,
  SETTINGS_FIELD_COUNT,
  SETTINGS_MODES,
} from './components/settings-picker.js';
import type {
  Action,
  FleetEntry,
  QueueItem,
  State,
} from './app-state.js';
// Re-export types from app-state.ts for backward compatibility.
export type {
  Action,
  DraftEntry,
  FleetEntry,
  GoalSummary,
  QueueItem,
  Settings,
  SlashCommandMatch,
  State,
} from './app-state.js';

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
    case 'clearInput':
      return {
        ...state,
        buffer: '',
        cursor: 0,
        historyIndex: 0,
        picker: { open: false, query: '', matches: [], selected: 0 },
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'clearHistory': {
      // Keep only the banner entry (always first, id=0). Any other entries
      // (user messages, assistant responses, slash results) are discarded so
      // the TUI starts fresh after /clear.
      const banner = state.entries.find((e) => e.kind === 'banner');
      return {
        ...state,
        entries: banner ? [banner] : state.entries,
        queue: [],
        nextQueueId: 1,
        scrollOffset: 0,
        pendingNewLines: 0,
        // Reset fleet state on /clear so old subagent entries don't
        // cause the LiveActivityStrip to render stale spacers, and
        // the fleet cost/tokens chips show zero.
        fleet: {},
        fleetCost: 0,
        fleetTokens: { input: 0, output: 0 },
        leader: {
          iterations: 0,
          toolCalls: 0,
          recentTools: [],
          currentTool: undefined,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          iterating: false,
        },
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
    case 'steerStart':
      return { ...state, steeringPending: true, steerSnapshot: action.snapshot };
    case 'steerConsume':
      return { ...state, steeringPending: false, steerSnapshot: null, interrupts: 0 };
    case 'resetInterrupts':
      return { ...state, interrupts: 0 };
    case 'hint':
      return { ...state, hint: action.text };
    case 'brainStatus':
      return {
        ...state,
        brain: {
          state: action.state,
          source: action.source,
          risk: action.risk,
          summary: action.summary,
          updatedAt: Date.now(),
        },
      };
    case 'brainPromptSet':
      return { ...state, brainPrompt: action.prompt };
    case 'brainPromptClear':
      return { ...state, brainPrompt: null };
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
          filteredOptions: [],
          selected: 0,
          hint: undefined,
          searchQuery: '',
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
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
        },
      };
    case 'modelPickerMove': {
      if (!state.modelPicker.open) return state;
      const list =
        state.modelPicker.step === 'provider'
          ? state.modelPicker.providerOptions
          : state.modelPicker.filteredOptions;
      const len = list.length;
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
          filteredOptions: action.models,
          selected: 0,
          pickedProviderId: action.providerId,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerBack':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'provider',
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          pickedProviderId: undefined,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerSearch': {
      if (!state.modelPicker.open || state.modelPicker.step !== 'model') return state;
      const q = action.query.toLowerCase();
      const filtered = q
        ? state.modelPicker.modelOptions.filter((id) => id.toLowerCase().includes(q))
        : state.modelPicker.modelOptions;
      const selected =
        filtered.length > 0 ? Math.min(state.modelPicker.selected, filtered.length - 1) : 0;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          filteredOptions: filtered,
          selected,
          searchQuery: action.query,
          hint: undefined,
        },
      };
    }
    case 'modelPickerHint':
      return {
        ...state,
        modelPicker: { ...state.modelPicker, hint: action.text },
      };
    case 'autonomyPickerOpen':
      return {
        ...state,
        autonomyPicker: { open: true, options: action.options, selected: 0, hint: undefined },
      };
    case 'autonomyPickerClose':
      return {
        ...state,
        autonomyPicker: { open: false, options: [], selected: 0 },
      };
    case 'autonomyPickerMove': {
      const n = state.autonomyPicker.options.length;
      if (n === 0) return state;
      const next = (state.autonomyPicker.selected + action.delta + n) % n;
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, selected: next },
      };
    }
    case 'autonomyPickerHint':
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, hint: action.text },
      };
    case 'settingsOpen':
      return {
        ...state,
        settingsPicker: {
          open: true,
          field: 0,
          mode: action.mode,
          delayMs: action.delayMs,
          titleAnimation: action.titleAnimation,
          yolo: action.yolo,
          streamFleet: action.streamFleet,
          chime: action.chime,
          confirmExit: action.confirmExit,
          nextPrediction: action.nextPrediction,
          featureMcp: action.featureMcp,
          featurePlugins: action.featurePlugins,
          featureMemory: action.featureMemory,
          featureSkills: action.featureSkills,
          featureModelsRegistry: action.featureModelsRegistry,
          contextAutoCompact: action.contextAutoCompact,
          contextStrategy: action.contextStrategy,
          logLevel: action.logLevel,
          auditLevel: action.auditLevel,
          indexOnStart: action.indexOnStart,
          maxIterations: action.maxIterations,
          hint: undefined,
        },
      };
    case 'settingsClose':
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, open: false, hint: undefined },
      };
    case 'settingsFieldMove': {
      const next = (state.settingsPicker.field + action.delta + SETTINGS_FIELD_COUNT) % SETTINGS_FIELD_COUNT;
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, field: next, hint: undefined },
      };
    }
    case 'settingsFieldSet': {
      const field =
        action.field >= 0 && action.field < SETTINGS_FIELD_COUNT ? action.field : 0;
      return { ...state, settingsPicker: { ...state.settingsPicker, field, hint: undefined } };
    }
    case 'settingsValueChange': {
      const sp = state.settingsPicker;
      const f = sp.field;
      // Field 0: autonomy mode (cycle SETTINGS_MODES)
      if (f === 0) {
        const i = SETTINGS_MODES.indexOf(sp.mode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + SETTINGS_MODES.length) % SETTINGS_MODES.length;
        return { ...state, settingsPicker: { ...sp, mode: expectDefined(SETTINGS_MODES[next]), hint: undefined } };
      }
      // Field 1: delay presets
      if (f === 1) {
        const j = DELAY_PRESETS_MS.indexOf(sp.delayMs);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + DELAY_PRESETS_MS.length) % DELAY_PRESETS_MS.length;
        return { ...state, settingsPicker: { ...sp, delayMs: expectDefined(DELAY_PRESETS_MS[next]), hint: undefined } };
      }
      // Field 2–7: UX boolean toggles
      if (f === 2) return { ...state, settingsPicker: { ...sp, titleAnimation: !sp.titleAnimation, hint: undefined } };
      if (f === 3) return { ...state, settingsPicker: { ...sp, yolo: !sp.yolo, hint: undefined } };
      if (f === 4) return { ...state, settingsPicker: { ...sp, streamFleet: !sp.streamFleet, hint: undefined } };
      if (f === 5) return { ...state, settingsPicker: { ...sp, chime: !sp.chime, hint: undefined } };
      if (f === 6) return { ...state, settingsPicker: { ...sp, confirmExit: !sp.confirmExit, hint: undefined } };
      if (f === 7) return { ...state, settingsPicker: { ...sp, nextPrediction: !sp.nextPrediction, hint: undefined } };
      // Field 8–12: Features boolean toggles
      if (f === 8) return { ...state, settingsPicker: { ...sp, featureMcp: !sp.featureMcp, hint: undefined } };
      if (f === 9) return { ...state, settingsPicker: { ...sp, featurePlugins: !sp.featurePlugins, hint: undefined } };
      if (f === 10) return { ...state, settingsPicker: { ...sp, featureMemory: !sp.featureMemory, hint: undefined } };
      if (f === 11) return { ...state, settingsPicker: { ...sp, featureSkills: !sp.featureSkills, hint: undefined } };
      if (f === 12) return { ...state, settingsPicker: { ...sp, featureModelsRegistry: !sp.featureModelsRegistry, hint: undefined } };
      // Field 13: context auto-compact (boolean)
      if (f === 13) return { ...state, settingsPicker: { ...sp, contextAutoCompact: !sp.contextAutoCompact, hint: undefined } };
      // Field 14: compactor strategy (cycle)
      if (f === 14) {
        const i = COMPACTOR_STRATEGIES.indexOf(sp.contextStrategy);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + COMPACTOR_STRATEGIES.length) % COMPACTOR_STRATEGIES.length;
        return { ...state, settingsPicker: { ...sp, contextStrategy: expectDefined(COMPACTOR_STRATEGIES[next]), hint: undefined } };
      }
      // Field 15: log level (cycle)
      if (f === 15) {
        const i = LOG_LEVELS.indexOf(sp.logLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + LOG_LEVELS.length) % LOG_LEVELS.length;
        return { ...state, settingsPicker: { ...sp, logLevel: expectDefined(LOG_LEVELS[next]), hint: undefined } };
      }
      // Field 16: audit level (cycle)
      if (f === 16) {
        const i = AUDIT_LEVELS.indexOf(sp.auditLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + AUDIT_LEVELS.length) % AUDIT_LEVELS.length;
        return { ...state, settingsPicker: { ...sp, auditLevel: expectDefined(AUDIT_LEVELS[next]), hint: undefined } };
      }
      // Field 17: index on start (boolean)
      if (f === 17) return { ...state, settingsPicker: { ...sp, indexOnStart: !sp.indexOnStart, hint: undefined } };
      // Field 18: max iterations (cycle presets)
      {
        const j = MAX_ITERATIONS_PRESETS.indexOf(sp.maxIterations);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + MAX_ITERATIONS_PRESETS.length) % MAX_ITERATIONS_PRESETS.length;
        return { ...state, settingsPicker: { ...sp, maxIterations: expectDefined(MAX_ITERATIONS_PRESETS[next]), hint: undefined } };
      }
    }
    case 'settingsHint':
      return { ...state, settingsPicker: { ...state.settingsPicker, hint: action.text } };
    case 'confirmOpen':
      return { ...state, confirmQueue: [...state.confirmQueue, action.info] };
    case 'confirmClose':
      return { ...state, confirmQueue: state.confirmQueue.slice(1) };
    case 'enhanceOpen':
      return { ...state, enhance: action.info };
    case 'enhanceClose':
      return { ...state, enhance: null };
    case 'enhanceSet':
      return { ...state, enhanceEnabled: action.enabled };
    case 'enhanceBusy':
      return { ...state, enhanceBusy: action.on };
    case 'escConfirmOpen':
      return { ...state, escConfirm: { snapshot: action.snapshot } };
    case 'escConfirmClose':
      return { ...state, escConfirm: null };
    case 'resetContextChip':
      return { ...state, contextChipVersion: state.contextChipVersion + 1 };
    // --- Fleet ---
    case 'fleetSeed': {
      const seeded: Record<string, FleetEntry> = {};
      for (const e of action.entries) {
        seeded[e.id] = {
          ...e,
          recentTools: e.recentTools ?? [],
          recentMessages: e.recentMessages ?? [],
        };
      }
      return { ...state, fleet: seeded, fleetCost: action.cost };
    }
    case 'fleetSpawn': {
      const existing = state.fleet[action.id];
      const incomingName = action.name ?? action.id.slice(0, 8);
      // Placeholder names that should be overwritten when a better name arrives.
      // "adhoc" is what MultiAgentHost.spawn() seeds before Director.spawn()
      // assigns the real nickname. id-prefix fallbacks also count as placeholders.
      const isPlaceholderName = (name: string) =>
        name === 'adhoc' ||
        name === 'subagent' ||
        name === 'generic' ||
        name.startsWith('slot-') ||
        name === action.id.slice(0, 8);

      if (existing) {
        // If we already have an entry but it has a placeholder name and the
        // incoming name is a real improvement, update the name. This handles
        // the race between EventBus's "subagent.spawned" (which fires before
        // Director.spawn() assigns the nickname) and FleetBus's
        // "subagent.assigned" (which fires after the manifest is updated).
        if (
          isPlaceholderName(existing.name) &&
          !isPlaceholderName(incomingName) &&
          incomingName !== existing.name
        ) {
          return {
            ...state,
            fleet: {
              ...state.fleet,
              [action.id]: { ...existing, name: incomingName },
            },
          };
        }
        return state;
      }
      const entry: FleetEntry = {
        id: action.id,
        name: incomingName,
        provider: action.provider,
        model: action.model,
        status: 'idle',
        streamingText: '',
        iterations: 0,
        toolCalls: 0,
        recentTools: [],
        recentMessages: [],
        cost: 0,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        transcriptPath: action.transcriptPath,
      };
      return { ...state, fleet: { ...state.fleet, [action.id]: entry } };
    }
    case 'fleetToolStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            currentTool: { name: action.name, startedAt: Date.now() },
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetToolEnd': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, currentTool: undefined, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: 'running' as const,
            streamingText: '',
            budgetWarning: undefined, // clear on restart
            startedAt: Date.now(),
          },
        },
      };
    }
    case 'fleetDelta': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      // Keep last 500 chars of streaming text for display (refactor plans are verbose)
      const appended = (cur.streamingText + action.text).slice(-500);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, streamingText: appended, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetMessage': {
      const cur = state.fleet[action.id];
      const text = action.text.trim().replace(/\s+/g, ' ');
      if (!cur || !text) return state;
      const now = Date.now();
      const recentMessages = [...(cur.recentMessages ?? []), { text, at: now }].slice(-2);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, recentMessages, lastEventAt: now },
        },
      };
    }
    case 'fleetTool': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      const now = Date.now();
      const recentTools =
        action.name !== undefined
          ? [
              ...(cur.recentTools ?? []),
              {
                name: action.name,
                ok: action.ok,
                durationMs: action.durationMs,
                outputBytes: action.outputBytes,
                outputLines: action.outputLines,
                at: now,
              },
            ].slice(-2)
          : (cur.recentTools ?? []);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            toolCalls: cur.toolCalls + 1,
            recentTools,
            lastEventAt: now,
          },
        },
      };
    }
    case 'fleetUsage': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: { ...state.fleet, [action.id]: { ...cur, lastEventAt: Date.now() } },
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
            currentTool: undefined,
            budgetWarning: undefined, // clear on done/restart
            lastEventAt: Date.now(),
            failureReason: action.failureReason,
          },
        },
      };
    }
    case 'fleetBudgetWarning': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            budgetWarning: {
              kind: action.kind,
              used: action.used,
              limit: action.limit,
              at: Date.now(),
            },
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetBudgetExtended': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            // The director sends the authoritative cumulative count; trust it
            // over a local increment so a dropped event can't desync the badge.
            extensions: action.totalExtensions,
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetCtxPct': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            ctxPct: action.load,
            ctxTokens: action.tokens,
            ctxMaxTokens: action.maxContext,
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetCost': {
      // Fold per-subagent cost into each live fleet entry so the AgentsMonitor
      // can show a per-agent `$` chip. Only touches entries we already track.
      let fleet = state.fleet;
      if (action.perAgent) {
        let changed = false;
        const next: Record<string, FleetEntry> = {};
        for (const [id, entry] of Object.entries(state.fleet)) {
          const cost = action.perAgent[id]?.cost;
          if (cost !== undefined && cost !== entry.cost) {
            next[id] = { ...entry, cost };
            changed = true;
          } else {
            next[id] = entry;
          }
        }
        if (changed) fleet = next;
      }
      return {
        ...state,
        fleet,
        fleetCost: action.cost,
        fleetTokens:
          action.input !== undefined || action.output !== undefined
            ? {
                input: action.input ?? state.fleetTokens.input,
                output: action.output ?? state.fleetTokens.output,
              }
            : state.fleetTokens,
      };
    }
    case 'fleetConcurrency': {
      return { ...state, fleetConcurrency: action.n };
    }
    case 'leaderIterStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          iterations: state.leader.iterations + 1,
          iterating: true,
          lastEventAt: Date.now(),
        },
      };
    }
    case 'leaderIterEnd': {
      return {
        ...state,
        leader: { ...state.leader, iterating: false, lastEventAt: Date.now() },
      };
    }
    case 'leaderToolStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          currentTool: { name: action.name, startedAt: Date.now() },
          lastEventAt: Date.now(),
        },
      };
    }
    case 'leaderToolEnd': {
      const now = Date.now();
      const recentTools = [
        ...state.leader.recentTools,
        { name: action.name, ok: action.ok, durationMs: action.durationMs, at: now },
      ].slice(-8);
      return {
        ...state,
        leader: {
          ...state.leader,
          toolCalls: state.leader.toolCalls + 1,
          currentTool: undefined,
          recentTools,
          lastEventAt: now,
        },
      };
    }
    case 'leaderCtxPct': {
      return {
        ...state,
        leader: {
          ...state.leader,
          ctxPct: action.load,
          ctxTokens: action.tokens,
          ctxMaxTokens: action.maxContext,
          lastEventAt: Date.now(),
        },
      };
    }
    case 'setStreamFleet': {
      return { ...state, streamFleet: action.enabled };
    }
    case 'toggleMonitor': {
      return { ...state, monitorOpen: !state.monitorOpen };
    }
    case 'toggleAgentsMonitor': {
      return { ...state, agentsMonitorOpen: !state.agentsMonitorOpen };
    }
    case 'toggleHelp': {
      return { ...state, helpOpen: !state.helpOpen };
    }
    case 'toggleTodosMonitor': {
      return { ...state, todosMonitorOpen: !state.todosMonitorOpen };
    }
    case 'toggleQueuePanel': {
      return { ...state, queuePanelOpen: !state.queuePanelOpen };
    }
    case 'toggleProcessList': {
      return { ...state, processListOpen: !state.processListOpen };
    }
    case 'toggleGoalPanel': {
      return { ...state, goalPanelOpen: !state.goalPanelOpen };
    }
    case 'checkpointReceived': {
      const existing = state.checkpoints.find((c) => c.promptIndex === action.cp.promptIndex);
      if (existing) return state;
      return { ...state, checkpoints: [...state.checkpoints, action.cp] };
    }
    case 'rewindOverlayOpen': {
      return {
        ...state,
        rewindOverlay: { checkpoints: state.checkpoints, selected: state.checkpoints.length - 1 },
      };
    }
    case 'rewindOverlayClose': {
      return { ...state, rewindOverlay: null };
    }
    case 'rewindOverlayMove': {
      if (!state.rewindOverlay) return state;
      const len = state.rewindOverlay.checkpoints.length;
      if (len === 0) return { ...state, rewindOverlay: null };
      const selected = Math.max(0, Math.min(len - 1, state.rewindOverlay.selected + action.delta));
      return { ...state, rewindOverlay: { ...state.rewindOverlay, selected } };
    }
    case 'sessionRewound': {
      return {
        ...state,
        checkpoints: state.checkpoints.filter((c) => c.promptIndex <= action.toPromptIndex),
        rewindOverlay: null,
      };
    }
    case 'eternalStage': {
      return { ...state, eternalStage: action.stage };
    }
    case 'goalSummary': {
      return { ...state, goalSummary: action.summary };
    }
    case 'autoPhaseInit': {
      return {
        ...state,
        autoPhase: {
          title: action.title,
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: false,
        },
      };
    }
    case 'autoPhasePhaseUpdate': {
      // Lazily initialize autoPhase state on first phase event — the title
      // is not shown in the PhaseMonitor so a placeholder is fine here.
      const existing = state.autoPhase ?? {
        title: 'AutoPhase',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: false,
      };
      return {
        ...state,
        autoPhase: {
          ...existing,
          phases: {
            ...existing.phases,
            [action.phaseId]: {
              name: action.name,
              status: action.status,
              completedTasks: action.completedTasks,
              totalTasks: action.totalTasks,
              startedAt: action.startedAt,
            },
          },
        },
      };
    }
    case 'autoPhaseRunningPhases': {
      if (!state.autoPhase) return state;
      return {
        ...state,
        autoPhase: { ...state.autoPhase, runningPhaseIds: action.phaseIds },
      };
    }
    case 'autoPhaseElapsed': {
      if (!state.autoPhase) return state;
      return { ...state, autoPhase: { ...state.autoPhase, elapsedMs: action.ms } };
    }
    case 'autoPhaseMonitorToggle': {
      if (!state.autoPhase) return state;
      return {
        ...state,
        autoPhase: { ...state.autoPhase, monitorOpen: !state.autoPhase.monitorOpen },
      };
    }
    case 'autoPhaseReset': {
      return { ...state, autoPhase: null };
    }
    case 'worktreeUpsert': {
      const prev = state.worktrees[action.handleId];
      const merged: WorktreeRow & { baseBranch?: string | undefined } = {
        branch: '',
        ownerLabel: '',
        status: 'active',
        insertions: 0,
        deletions: 0,
        files: 0,
        allocatedAt: Date.now(),
        ...prev,
        ...action.row,
      };
      return {
        ...state,
        worktrees: { ...state.worktrees, [action.handleId]: merged },
        worktreeBase: action.baseBranch ?? state.worktreeBase,
      };
    }
    case 'worktreeRemove': {
      if (!state.worktrees[action.handleId]) return state;
      const next = { ...state.worktrees };
      delete next[action.handleId];
      return { ...state, worktrees: next };
    }
    case 'worktreeMonitorToggle': {
      return { ...state, worktreeMonitorOpen: !state.worktreeMonitorOpen };
    }
    // --- In-app chat scroll ---
    case 'scrollBy': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + action.delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollPage': {
      const page = Math.max(1, state.viewportRows - 1);
      const delta = action.dir === 'up' ? page : -page;
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollTo': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, action.offset));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollToBottom':
      return { ...state, scrollOffset: 0, pendingNewLines: 0 };
    case 'scrollToTop': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      return { ...state, scrollOffset: maxOffset };
    }
    case 'setMeasuredLines': {
      const newTotal = action.totalLines;
      const oldTotal = state.totalLines;
      const maxOffset = Math.max(0, newTotal - state.viewportRows);
      // Content grew while the user is scrolled up → keep the visible window
      // anchored on the same older rows by pushing the offset along with the
      // growth, and surface the new-line count for the "jump to bottom" hint.
      if (state.scrollOffset > 0 && newTotal > oldTotal) {
        const grew = newTotal - oldTotal;
        return {
          ...state,
          totalLines: newTotal,
          scrollOffset: Math.min(maxOffset, state.scrollOffset + grew),
          pendingNewLines: state.pendingNewLines + grew,
        };
      }
      // Pinned, or content shrank (e.g. /clear): re-clamp and keep following.
      return {
        ...state,
        totalLines: newTotal,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'setViewportRows': {
      const maxOffset = Math.max(0, state.totalLines - action.rows);
      return {
        ...state,
        viewportRows: action.rows,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'fleetBatch':
      // Fold each batched action through the reducer; one new state, one render.
      return action.actions.reduce((s, a) => reducer(s, a), state);
    // --- Collab session ---
    case 'collabSubagentSpawned': {
      // Lazily initialize collab state on the first subagent spawn.
      if (state.collabSession) return state;
      return {
        ...state,
        collabSession: {
          sessionId: null,
          bugCount: 0,
          planCount: 0,
          evalCount: 0,
          overallVerdict: null,
          timeline: [{ at: Date.now(), icon: '⚡', color: 'cyan', text: `${action.role} spawned` }],
          startedAt: Date.now(),
        },
      };
    }
    case 'collabBugFound': {
      const cs = state.collabSession;
      if (!cs) {
        // Lazily bootstrap collab state on first event.
        return {
          ...state,
          collabSession: {
            sessionId: action.sessionId,
            bugCount: 1,
            planCount: 0,
            evalCount: 0,
            overallVerdict: null,
            timeline: [
              {
                at: Date.now(),
                icon: '🐛',
                color: 'red',
                text: `bug: ${action.description.slice(0, 60)}…`,
              },
            ],
            startedAt: Date.now(),
          },
        };
      }
      const entry = {
        at: Date.now(),
        icon: '🐛',
        color: 'red',
        text: `bug [${action.severity}]: ${action.description.slice(0, 55)}…`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          bugCount: cs.bugCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabPlanEmitted': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '📐',
        color: 'yellow',
        text: `plan [${action.riskScore}]: ${action.phaseCount} phases`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          planCount: cs.planCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabEvalComplete': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '⚖️',
        color:
          action.verdict === 'approve' ? 'green' : action.verdict === 'reject' ? 'red' : 'yellow',
        text: `eval ${action.score}/10 → ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          evalCount: cs.evalCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabSessionDone': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '🏁',
        color: 'green',
        text: `session done — ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          overallVerdict: action.verdict,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
  }
}
