import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  WebContentsView,
  type BaseWindowConstructorOptions,
  type MenuItemConstructorOptions,
} from 'electron';
import type {
  DesktopRuntimeRecord,
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
  DesktopWebuiStatusSnapshot,
  DesktopWindowState,
} from '../shared/types.js';
import { DesktopAgentBridge } from './agent-bridge.js';
import { IPC } from './ipc.js';
import { DesktopRuntimeManager, preloadPath, rendererIndexPath, webuiPreloadPath } from './runtime-manager.js';
import {
  buildWebuiCommandFallbackScript,
  normalizeDesktopWebuiCommand,
} from './webui-command-bridge.js';

const manager = new DesktopRuntimeManager();
const bridge = new DesktopAgentBridge();

const OPEN_EXTERNAL_ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SIDEBAR_WIDTH_WIDE = 292;
const SIDEBAR_WIDTH_MEDIUM = 276;
const SIDEBAR_WIDTH_NARROW = 252;
const SIDEBAR_WIDTH_COLLAPSED = 56;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;
const MAX_PENDING_WEBUI_COMMANDS = 50;
const MAX_PENDING_FLUSH_ATTEMPTS = 80;
const WEBUI_COMMAND_FALLBACK_MS = 350;
const WEBUI_COMMAND_ACK_TIMEOUT_MS = 2_000;
app.setAppUserModelId('com.wrongstack.desktop');
app.setPath('userData', path.join(wstackGlobalRoot(), 'desktop', 'electron-profile'));

interface DesktopWebuiRuntimeView {
  runtimeId: string;
  view: WebContentsView;
  url: string | null;
  status: DesktopWebuiStatusSnapshot;
  bridgeReady: boolean;
  attached: boolean;
  pendingCommands: DesktopWebuiCommand[];
  pendingFlushTimer: ReturnType<typeof setTimeout> | null;
  pendingFlushAttempts: number;
}

interface PendingWebuiCommandAck {
  runtimeId: string;
  timer: ReturnType<typeof setTimeout>;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  resolve: (handled: boolean) => void;
}

function safeOpenExternal(target: string): void {
  let protocol: string;
  try {
    protocol = new URL(target).protocol;
  } catch {
    return;
  }
  if (OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has(protocol)) {
    void shell.openExternal(target);
  }
}

let mainWindow: BaseWindow | null = null;
let shellView: WebContentsView | null = null;
const webuiViews = new Map<string, DesktopWebuiRuntimeView>();
let activeWebuiRuntimeId: string | null = null;
let webuiStatus: DesktopWebuiStatusSnapshot = { runtimeId: null, status: 'idle' };
let webuiCommandSequence = 0;
let shellSidebarCollapsed = false;
const pendingWebuiCommandAcks = new Map<string, PendingWebuiCommandAck>();
let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
let quittingAfterCleanup = false;

async function createWindow(): Promise<void> {
  await manager.init();
  configureApplicationMenu();
  const windowState = validatedWindowState(manager.getWindowState());
  const windowOptions: BaseWindowConstructorOptions = {
    width: windowState?.width ?? 1320,
    height: windowState?.height ?? 860,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'WrongStack Desktop',
    backgroundColor: '#111217',
  };
  if (windowState?.x !== undefined) windowOptions.x = windowState.x;
  if (windowState?.y !== undefined) windowOptions.y = windowState.y;
  mainWindow = new BaseWindow(windowOptions);
  if (windowState?.maximized) {
    mainWindow.maximize();
  }

  shellView = new WebContentsView({
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.contentView.addChildView(shellView);
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });
  await shellView.webContents.loadFile(rendererIndexPath());

  mainWindow.on('resize', layoutViews);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);
  mainWindow.on('close', () => {
    if (saveWindowStateTimer) {
      clearTimeout(saveWindowStateTimer);
      saveWindowStateTimer = null;
    }
    void saveWindowState();
  });
  mainWindow.on('closed', () => {
    if (saveWindowStateTimer) {
      clearTimeout(saveWindowStateTimer);
      saveWindowStateTimer = null;
    }
    mainWindow = null;
    disposeAllWebuiEntries();
    shellView = null;
    activeWebuiRuntimeId = null;
    webuiStatus = { runtimeId: null, status: 'idle' };
  });
  layoutViews();
  syncActiveWebuiView();
  void restoreLastWorkspace();
}

function layoutViews(): void {
  if (!mainWindow || !shellView) return;
  const size = mainWindow.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;
  shellView.setBounds({ x: 0, y: 0, width, height });
  layoutWebuiViews(width, height);
}

function scheduleWindowStateSave(): void {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null;
    void saveWindowState();
  }, 350);
}

async function saveWindowState(): Promise<void> {
  if (!mainWindow) return;
  const bounds = mainWindow.getNormalBounds();
  await manager.saveWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  });
}

function layoutWebuiViews(windowWidth?: number, windowHeight?: number): void {
  if (!mainWindow) return;
  const size = mainWindow.getContentSize();
  const width = windowWidth ?? size[0] ?? 0;
  const height = windowHeight ?? size[1] ?? 0;
  const snapshot = manager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  const sidebarWidth = desktopSidebarWidth(width);
  const contentWidth = Math.max(0, width - sidebarWidth);
  for (const entry of webuiViews.values()) {
    if (active?.id === entry.runtimeId && active.status === 'running') {
      entry.view.setBounds({ x: sidebarWidth, y: 0, width: contentWidth, height });
    } else {
      entry.view.setBounds({ x: sidebarWidth, y: 0, width: 0, height });
    }
  }
}

function desktopSidebarWidth(windowWidth: number): number {
  if (shellSidebarCollapsed) return SIDEBAR_WIDTH_COLLAPSED;
  if (windowWidth < 900) return SIDEBAR_WIDTH_NARROW;
  if (windowWidth < 1180) return SIDEBAR_WIDTH_MEDIUM;
  return SIDEBAR_WIDTH_WIDE;
}

function setShellSidebarCollapsed(collapsed: boolean): void {
  shellSidebarCollapsed = collapsed;
  layoutWebuiViews();
  configureApplicationMenu();
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.shellSidebarCollapsedChanged, shellSidebarCollapsed);
}

function ensureWebuiEntry(runtimeId: string): DesktopWebuiRuntimeView | null {
  if (!mainWindow) return null;
  const existing = webuiViews.get(runtimeId);
  if (existing) return existing;

  const view = new WebContentsView({
    webPreferences: {
      preload: webuiPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const entry: DesktopWebuiRuntimeView = {
    runtimeId,
    view,
    url: null,
    status: { runtimeId, status: 'idle' },
    bridgeReady: false,
    attached: false,
    pendingCommands: [],
    pendingFlushTimer: null,
    pendingFlushAttempts: 0,
  };

  view.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, entry.url)) return;
    event.preventDefault();
    safeOpenExternal(url);
  });
  view.webContents.on('did-start-loading', () => {
    if (webuiViews.get(runtimeId) !== entry) return;
    entry.bridgeReady = false;
    setEntryWebuiStatus(entry, { runtimeId, status: 'loading' });
  });
  view.webContents.on('did-finish-load', () => {
    if (webuiViews.get(runtimeId) !== entry) return;
    schedulePendingWebuiFlush(entry);
  });
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (webuiViews.get(runtimeId) !== entry || errorCode === -3) return;
    setEntryWebuiStatus(entry, {
      runtimeId,
      status: 'error',
      error: errorDescription,
    });
  });
  view.webContents.on('render-process-gone', (_event, details) => {
    if (webuiViews.get(runtimeId) !== entry) return;
    setEntryWebuiStatus(entry, {
      runtimeId,
      status: 'error',
      error: `WebUI renderer exited: ${details.reason}`,
    });
  });
  webuiViews.set(runtimeId, entry);
  return entry;
}

function syncActiveWebuiView(): void {
  if (!mainWindow) return;
  const snapshot = manager.snapshot();
  pruneWebuiEntries(
    snapshot.runtimes.filter((runtime) => runtime.status === 'running').map((runtime) => runtime.id),
  );
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  if (!active || active.status !== 'running') {
    activeWebuiRuntimeId = active?.id ?? null;
    publishWebuiStatus({ runtimeId: active?.id ?? null, status: 'idle' });
    layoutWebuiViews();
    return;
  }

  const url = manager.getRuntimeUrlWithToken(active.id);
  if (!url) {
    activeWebuiRuntimeId = active.id;
    publishWebuiStatus({ runtimeId: active.id, status: 'idle' });
    layoutWebuiViews();
    return;
  }
  const entry = ensureWebuiEntry(active.id);
  if (!entry) return;
  activeWebuiRuntimeId = active.id;
  attachWebuiEntry(entry);
  layoutWebuiViews();
  publishWebuiStatus(entry.status);
  if (entry.url !== url) {
    entry.url = url;
    entry.bridgeReady = false;
    setEntryWebuiStatus(entry, { runtimeId: active.id, status: 'loading' });
    void entry.view.webContents.loadURL(url).catch((err) => {
      setEntryWebuiStatus(entry, {
        runtimeId: active.id,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('Failed to load desktop WebUI view:', err);
    });
  }
}

function broadcastState(): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.stateChanged, manager.snapshot());
}

function publishWebuiStatus(next: DesktopWebuiStatusSnapshot): void {
  webuiStatus = next;
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send(IPC.webuiStatusChanged, webuiStatus);
}

function setEntryWebuiStatus(
  entry: DesktopWebuiRuntimeView,
  next: DesktopWebuiStatusSnapshot,
): void {
  const previousPrefs = entry.status.prefs;
  entry.status = {
    ...next,
    prefs: next.prefs ?? entry.status.prefs,
    pendingCommands: entry.pendingCommands.length || undefined,
  };
  if (activeWebuiRuntimeId === entry.runtimeId) {
    publishWebuiStatus(entry.status);
    if (menuRelevantPrefsChanged(previousPrefs, entry.status.prefs)) {
      configureApplicationMenu();
    }
  }
}

function menuRelevantPrefsChanged(
  previous: DesktopWebuiPrefs | undefined,
  next: DesktopWebuiPrefs | undefined,
): boolean {
  return (
    previous?.yolo !== next?.yolo ||
    previous?.nextPrediction !== next?.nextPrediction ||
    previous?.contextAutoCompact !== next?.contextAutoCompact
  );
}

function runtimeWsUrlOrThrow(runtimeId: string): string {
  const wsUrl = manager.getRuntimeWsUrlWithToken(runtimeId);
  if (!wsUrl) throw new Error(`Runtime not found: ${runtimeId}`);
  return wsUrl;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => manager.snapshot());
  ipcMain.handle(IPC.getConversation, (_event, runtimeId: string) => bridge.snapshot(runtimeId));
  ipcMain.handle(IPC.getWebuiStatus, () => webuiStatus);
  ipcMain.handle(IPC.navigateWebui, async (_event, command: unknown) =>
    dispatchWebuiCommand(command),
  );
  ipcMain.handle(IPC.reloadWebui, async () => reloadActiveWebuiView());
  ipcMain.handle(IPC.setShellSidebarCollapsed, (_event, collapsed: unknown) => {
    setShellSidebarCollapsed(collapsed === true);
    return true;
  });
  ipcMain.handle(IPC.openSettings, async () => openSettings());
  ipcMain.handle(IPC.openProjectSession, async (_event, runtimeId?: string | undefined) => {
    return openProjectSession(runtimeId);
  });
  ipcMain.handle(IPC.openProject, async (_event, requestedRoot?: string | undefined) => {
    return openProject(requestedRoot);
  });
  ipcMain.handle(IPC.registerProject, async (_event, requestedRoot?: string | undefined) => {
    return registerProject(requestedRoot);
  });
  ipcMain.handle(IPC.unregisterProject, async (_event, root: string) => {
    return unregisterProject(root);
  });
  ipcMain.handle(IPC.activateRuntime, async (_event, id: string) => {
    return activateRuntime(id);
  });
  ipcMain.handle(IPC.closeRuntime, async (_event, id: string) => {
    return closeRuntime(id);
  });
  ipcMain.handle(IPC.sendMessage, async (_event, id: string, content: string) =>
    bridge.sendMessage(id, runtimeWsUrlOrThrow(id), content),
  );
  ipcMain.handle(IPC.abortRuntime, async (_event, id: string) =>
    bridge.abort(id, runtimeWsUrlOrThrow(id)),
  );
  ipcMain.handle(IPC.openRuntimeInBrowser, async (_event, id: string) => {
    const url = manager.getRuntimeUrlWithToken(id);
    if (url) safeOpenExternal(url);
  });
  ipcMain.handle(IPC.revealRuntimeRoot, async (_event, id: string) => {
    const runtime = manager.getRuntime(id);
    if (runtime) await shell.openPath(runtime.root);
  });
  ipcMain.on(IPC.webuiReadyChanged, (event, ready: boolean) => {
    const entry = findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    entry.bridgeReady = ready === true;
    if (entry.bridgeReady) {
      setEntryWebuiStatus(entry, { ...entry.status, status: 'ready' });
      schedulePendingWebuiFlush(entry);
    } else if (entry.status.status === 'ready') {
      setEntryWebuiStatus(entry, { ...entry.status, status: 'loading' });
    }
  });
  ipcMain.on(IPC.webuiPrefsChanged, (event, prefs: unknown) => {
    const entry = findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    const sanitized = sanitizeWebuiPrefs(prefs);
    if (Object.keys(sanitized).length === 0) return;
    setEntryWebuiStatus(entry, {
      ...entry.status,
      prefs: { ...(entry.status.prefs ?? {}), ...sanitized },
    });
  });
  ipcMain.on(
    IPC.webuiCommandAck,
    (event, requestId: unknown, handled: unknown, _message?: unknown) => {
      const entry = findWebuiEntryBySenderId(event.sender.id);
      if (!entry || typeof requestId !== 'string') return;
      const pending = pendingWebuiCommandAcks.get(requestId);
      if (!pending || pending.runtimeId !== entry.runtimeId) return;
      settlePendingWebuiCommandAck(requestId, handled === true);
    },
  );
}

function findWebuiEntryBySenderId(senderId: number): DesktopWebuiRuntimeView | undefined {
  return Array.from(webuiViews.values()).find(
    (candidate) => candidate.view.webContents.id === senderId,
  );
}

function sanitizeWebuiPrefs(prefs: unknown): DesktopWebuiPrefs {
  const next: DesktopWebuiPrefs = {};
  if (!isRecord(prefs)) return next;
  if (typeof prefs['yolo'] === 'boolean') next.yolo = prefs['yolo'];
  if (typeof prefs['nextPrediction'] === 'boolean') next.nextPrediction = prefs['nextPrediction'];
  if (typeof prefs['contextAutoCompact'] === 'boolean') {
    next.contextAutoCompact = prefs['contextAutoCompact'];
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function dispatchWebuiCommand(commandInput: unknown): Promise<boolean> {
  const command = normalizeDesktopWebuiCommand(commandInput);
  if (!command) return false;
  const entry = getActiveWebuiEntry();
  if (!entry?.url) return false;
  if (entry.status.status !== 'ready') {
    if (!entry.view.webContents.isLoading() && entry.status.status !== 'error') {
      return dispatchWebuiCommandNow(entry, command);
    }
    queueWebuiCommand(entry, command);
    schedulePendingWebuiFlush(entry);
    return true;
  }
  if (!(await isWebuiCommandBridgeReady(entry))) {
    if (!entry.view.webContents.isLoading()) {
      return dispatchWebuiCommandNow(entry, command);
    }
    queueWebuiCommand(entry, command);
    schedulePendingWebuiFlush(entry);
    return true;
  }
  return dispatchWebuiCommandNow(entry, command);
}

async function reloadActiveWebuiView(): Promise<boolean> {
  const entry = getActiveWebuiEntry();
  if (!entry?.url) return false;
  entry.bridgeReady = false;
  setEntryWebuiStatus(entry, { runtimeId: entry.runtimeId, status: 'loading' });
  return entry.view.webContents
    .loadURL(entry.url)
    .then(() => true)
    .catch((err) => {
      setEntryWebuiStatus(entry, {
        runtimeId: entry.runtimeId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('Failed to reload desktop WebUI view:', err);
      return false;
    });
}

async function dispatchWebuiCommandNow(
  entry: DesktopWebuiRuntimeView,
  command: DesktopWebuiCommand,
): Promise<boolean> {
  if (webuiViews.get(entry.runtimeId) !== entry || !entry.url) return false;
  const requestId = nextWebuiCommandRequestId(entry.runtimeId);
  const commandWithRequestId: DesktopWebuiCommand = { ...command, requestId };
  return new Promise<boolean>((resolve) => {
    const fallbackTimer = setTimeout(() => {
      const pending = pendingWebuiCommandAcks.get(requestId);
      if (!pending) return;
      sendWebuiCommandDomFallback(entry, commandWithRequestId);
    }, WEBUI_COMMAND_FALLBACK_MS);
    const timer = setTimeout(() => {
      settlePendingWebuiCommandAck(requestId, false);
    }, WEBUI_COMMAND_ACK_TIMEOUT_MS);
    pendingWebuiCommandAcks.set(requestId, {
      runtimeId: entry.runtimeId,
      timer,
      fallbackTimer,
      resolve,
    });
    try {
      entry.view.webContents.send(IPC.webuiCommand, commandWithRequestId);
      if (activeWebuiRuntimeId === entry.runtimeId) {
        entry.view.webContents.focus();
      }
    } catch {
      settlePendingWebuiCommandAck(requestId, false);
    }
  });
}

function sendWebuiCommandDomFallback(
  entry: DesktopWebuiRuntimeView,
  command: DesktopWebuiCommand,
): void {
  if (webuiViews.get(entry.runtimeId) !== entry || entry.view.webContents.isDestroyed()) return;
  void entry.view.webContents
    .executeJavaScript(buildWebuiCommandFallbackScript(command), true)
    .catch(() => undefined);
}

function nextWebuiCommandRequestId(runtimeId: string): string {
  webuiCommandSequence += 1;
  return `${runtimeId}:${Date.now()}:${webuiCommandSequence}`;
}

function settlePendingWebuiCommandAck(requestId: string, handled: boolean): void {
  const pending = pendingWebuiCommandAcks.get(requestId);
  if (!pending) return;
  pendingWebuiCommandAcks.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
  if (handled) {
    const entry = webuiViews.get(pending.runtimeId);
    if (entry) {
      entry.bridgeReady = true;
      setEntryWebuiStatus(entry, { ...entry.status, status: 'ready' });
    }
  }
  pending.resolve(handled);
}

function settlePendingWebuiCommandAcksForRuntime(runtimeId: string, handled: boolean): void {
  for (const [requestId, pending] of [...pendingWebuiCommandAcks]) {
    if (pending.runtimeId === runtimeId) {
      settlePendingWebuiCommandAck(requestId, handled);
    }
  }
}

async function flushPendingWebuiCommands(entry: DesktopWebuiRuntimeView): Promise<void> {
  if (webuiViews.get(entry.runtimeId) !== entry) return;
  if (entry.pendingCommands.length === 0) return;
  if (!(await isWebuiCommandBridgeReady(entry))) {
    entry.pendingFlushAttempts += 1;
    const canFallback = !entry.view.webContents.isLoading() && entry.pendingFlushAttempts >= 4;
    if (!canFallback && entry.pendingFlushAttempts <= MAX_PENDING_FLUSH_ATTEMPTS) {
      schedulePendingWebuiFlush(entry);
      setEntryWebuiStatus(entry, entry.status);
      return;
    }
    if (!canFallback) {
      entry.pendingCommands.length = 0;
      setEntryWebuiStatus(entry, {
        runtimeId: entry.runtimeId,
        status: 'error',
        error: 'WebUI command bridge did not become ready.',
      });
      return;
    }
  }
  entry.pendingFlushAttempts = 0;
  const commands = entry.pendingCommands.splice(0, entry.pendingCommands.length);
  setEntryWebuiStatus(entry, entry.status);
  for (const command of commands) {
    await dispatchWebuiCommandNow(entry, command).catch(() => undefined);
  }
}

function schedulePendingWebuiFlush(entry: DesktopWebuiRuntimeView): void {
  if (entry.pendingFlushTimer) return;
  entry.pendingFlushTimer = setTimeout(() => {
    entry.pendingFlushTimer = null;
    void flushPendingWebuiCommands(entry);
  }, 250);
}

async function isWebuiCommandBridgeReady(entry: DesktopWebuiRuntimeView): Promise<boolean> {
  if (webuiViews.get(entry.runtimeId) !== entry || !entry.url) return false;
  return entry.bridgeReady;
}

function queueWebuiCommand(entry: DesktopWebuiRuntimeView, command: DesktopWebuiCommand): void {
  entry.pendingCommands.push(command);
  if (entry.pendingCommands.length > MAX_PENDING_WEBUI_COMMANDS) {
    entry.pendingCommands.splice(0, entry.pendingCommands.length - MAX_PENDING_WEBUI_COMMANDS);
  }
  entry.pendingFlushAttempts = 0;
  setEntryWebuiStatus(entry, entry.status);
}

function getActiveWebuiEntry(): DesktopWebuiRuntimeView | undefined {
  const activeId = manager.snapshot().activeRuntimeId;
  return activeId ? webuiViews.get(activeId) : undefined;
}

function attachWebuiEntry(entry: DesktopWebuiRuntimeView): void {
  if (!mainWindow) return;
  if (entry.attached) return;
  mainWindow.contentView.addChildView(entry.view);
  entry.attached = true;
}

function pruneWebuiEntries(runtimeIds: string[]): void {
  const live = new Set(runtimeIds);
  for (const [id, entry] of webuiViews) {
    if (!live.has(id)) {
      disposeWebuiEntry(entry);
    }
  }
}

function disposeWebuiEntry(entry: DesktopWebuiRuntimeView): void {
  webuiViews.delete(entry.runtimeId);
  entry.pendingCommands.length = 0;
  settlePendingWebuiCommandAcksForRuntime(entry.runtimeId, false);
  if (entry.pendingFlushTimer) {
    clearTimeout(entry.pendingFlushTimer);
    entry.pendingFlushTimer = null;
  }
  if (mainWindow && entry.attached) {
    mainWindow.contentView.removeChildView(entry.view);
  }
  entry.attached = false;
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close();
  }
  if (activeWebuiRuntimeId === entry.runtimeId) activeWebuiRuntimeId = null;
}

function disposeAllWebuiEntries(): void {
  for (const entry of Array.from(webuiViews.values())) {
    disposeWebuiEntry(entry);
  }
  webuiViews.clear();
}

async function openProject(requestedRoot?: string | undefined): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  let projectRoot = requestedRoot;
  if (!projectRoot) {
    const result = await dialog.showOpenDialog({
      title: 'Open Project',
      properties: ['openDirectory'],
    });
    projectRoot = result.filePaths[0];
  }
  if (!projectRoot) return manager.snapshot();
  await manager.openProject(projectRoot);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function registerProject(
  requestedRoot?: string | undefined,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  let projectRoot = requestedRoot;
  if (!projectRoot) {
    const result = await dialog.showOpenDialog({
      title: 'Register Project',
      properties: ['openDirectory'],
    });
    projectRoot = result.filePaths[0];
  }
  if (!projectRoot) return manager.snapshot();
  await manager.registerProject(projectRoot);
  broadcastState();
  return manager.snapshot();
}

async function unregisterProject(root: string): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  if (!root || typeof root !== 'string') return manager.snapshot();
  await manager.unregisterProject(root);
  broadcastState();
  return manager.snapshot();
}

async function openProjectSession(
  runtimeId?: string | undefined,
): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  const snapshot = manager.snapshot();
  const runtime =
    (runtimeId ? snapshot.runtimes.find((candidate) => candidate.id === runtimeId) : undefined) ??
    snapshot.runtimes.find((candidate) => candidate.id === snapshot.activeRuntimeId);
  if (!runtime || runtime.kind !== 'project') {
    return openProject();
  }
  await manager.openProject(runtime.root, { forceNew: true });
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function openSettings(): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  const snapshot = manager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  if (!active || active.kind === 'global-settings' || active.status !== 'running') {
    const root = desktopSettingsWorkspaceRoot();
    await fs.mkdir(root, { recursive: true });
    await manager.openProject(root, {
      name: 'Global Settings',
      kind: 'global-settings',
      touchRecent: false,
    });
    syncActiveWebuiView();
    broadcastState();
  }
  await dispatchWebuiCommand({ view: 'settings' });
  return manager.snapshot();
}

async function activateRuntime(id: string): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  await manager.activateRuntime(id);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function closeRuntime(id: string): Promise<ReturnType<DesktopRuntimeManager['snapshot']>> {
  bridge.close(id);
  await manager.closeRuntime(id);
  const entry = webuiViews.get(id);
  if (entry) disposeWebuiEntry(entry);
  syncActiveWebuiView();
  broadcastState();
  return manager.snapshot();
}

async function restoreLastWorkspace(): Promise<void> {
  await manager.restoreLastWorkspace();
  syncActiveWebuiView();
  broadcastState();
}

function activeRuntimeId(): string | null {
  return manager.snapshot().activeRuntimeId;
}

interface ProjectMenuActions {
  activate(runtimeId: string): void;
  activateAndNavigate(runtimeId: string, command: DesktopWebuiCommand): void;
  newSession(runtimeId: string): void;
  openBrowser(runtimeId: string): void;
  reload(runtimeId: string): void;
  close(runtimeId: string): void;
  reveal(runtimeId: string): void;
}

interface ProjectMenuGroup {
  key: string;
  name: string;
  root: string;
  sessions: DesktopRuntimeRecord[];
}

function buildProjectsMenu(
  runtimes: DesktopRuntimeRecord[],
  actions: ProjectMenuActions,
): MenuItemConstructorOptions[] {
  const projectGroups = groupProjectRuntimesForMenu(runtimes);
  const menu: MenuItemConstructorOptions[] = [
    { label: 'Open Project...', accelerator: 'CmdOrCtrl+O', click: () => void openProject() },
    { label: 'Register Project...', click: () => void registerProject() },
    { type: 'separator' },
  ];

  if (projectGroups.length === 0) {
    menu.push({ label: 'No open project sessions', enabled: false });
    return menu;
  }

  for (const group of projectGroups) {
    menu.push({
      label: group.name,
      submenu: [
        {
          label: 'New Session',
          click: () => actions.newSession(group.sessions[0]?.id ?? ''),
          enabled: Boolean(group.sessions[0]),
        },
        {
          label: 'Reveal Project Folder',
          click: () => actions.reveal(group.sessions[0]?.id ?? ''),
          enabled: Boolean(group.sessions[0]),
        },
        { type: 'separator' },
        ...group.sessions.map((runtime, index) => buildSessionMenu(runtime, index + 1, actions)),
      ],
    });
  }
  return menu;
}

function buildSessionMenu(
  runtime: DesktopRuntimeRecord,
  index: number,
  actions: ProjectMenuActions,
): MenuItemConstructorOptions {
  const running = runtime.status === 'running';
  const label = `Session ${index} · ${runtime.status}`;
  return {
    label,
    submenu: [
      {
        label: 'Quick View',
        click: () => actions.activate(runtime.id),
      },
      {
        label: 'WebUI',
        enabled: running,
        submenu: [
          {
            label: 'Chat',
            click: () => actions.activateAndNavigate(runtime.id, { activity: 'chat', view: 'chat' }),
          },
          {
            label: 'Focus Prompt',
            click: () => actions.activateAndNavigate(runtime.id, { action: 'focus-chat' }),
          },
          {
            label: 'Terminal',
            click: () => actions.activateAndNavigate(runtime.id, { terminal: 'toggle' }),
          },
          {
            label: 'New Terminal',
            click: () => actions.activateAndNavigate(runtime.id, { terminal: 'new' }),
          },
          { type: 'separator' },
          {
            label: 'Files',
            click: () => actions.activateAndNavigate(runtime.id, { activity: 'files', view: 'files' }),
          },
          {
            label: 'Changes',
            click: () => actions.activateAndNavigate(runtime.id, { activity: 'changes', view: 'changes' }),
          },
          {
            label: 'Sessions',
            click: () => actions.activateAndNavigate(runtime.id, { view: 'sessions' }),
          },
          {
            label: 'Fleet HQ',
            click: () => actions.activateAndNavigate(runtime.id, { activity: 'officemap', view: 'officemap' }),
          },
          {
            label: 'Settings',
            click: () => actions.activateAndNavigate(runtime.id, { view: 'settings' }),
          },
          { type: 'separator' },
          {
            label: 'Command Palette',
            click: () => actions.activateAndNavigate(runtime.id, { action: 'open-command-palette' }),
          },
          {
            label: 'Model Switcher',
            click: () => actions.activateAndNavigate(runtime.id, { action: 'open-model-switcher' }),
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Open in Browser',
        enabled: running,
        click: () => actions.openBrowser(runtime.id),
      },
      {
        label: 'Reload WebUI',
        enabled: running,
        click: () => actions.reload(runtime.id),
      },
      {
        label: 'Close Session',
        click: () => actions.close(runtime.id),
      },
    ],
  };
}

function groupProjectRuntimesForMenu(runtimes: DesktopRuntimeRecord[]): ProjectMenuGroup[] {
  const groups = new Map<string, ProjectMenuGroup>();
  for (const runtime of runtimes) {
    if (runtime.kind !== 'project') continue;
    const key = normalizeMenuRoot(runtime.root);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(runtime);
      continue;
    }
    groups.set(key, {
      key,
      name: path.basename(runtime.root) || runtime.name,
      root: runtime.root,
      sessions: [runtime],
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeMenuRoot(root: string): string {
  return path.resolve(root).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function configureApplicationMenu(): void {
  const navigate = (command: DesktopWebuiCommand) => {
    void dispatchWebuiCommand(command);
  };
  const activateAndNavigate = (runtimeId: string, command: DesktopWebuiCommand) => {
    void activateRuntime(runtimeId).then(() => dispatchWebuiCommand(command));
  };
  const reloadRuntimeWebui = (runtimeId: string) => {
    void activateRuntime(runtimeId).then(() => reloadActiveWebuiView());
  };
  const snapshot = manager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  const hasActiveRuntime = Boolean(active);
  const hasActiveWebui = active?.status === 'running';
  const hasActiveProjectWebui = hasActiveWebui && active?.kind === 'project';
  const activeWebuiPrefs = active ? webuiViews.get(active.id)?.status.prefs : undefined;
  const yoloChecked = activeWebuiPrefs?.yolo === true;
  const nextPredictionChecked = activeWebuiPrefs?.nextPrediction === true;
  const contextAutoCompactChecked = activeWebuiPrefs?.contextAutoCompact === true;
  const webuiItem = (item: MenuItemConstructorOptions): MenuItemConstructorOptions => ({
    ...item,
    enabled: item.enabled ?? hasActiveWebui,
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Project...', accelerator: 'CmdOrCtrl+O', click: () => void openProject() },
        { label: 'Register Project...', click: () => void registerProject() },
        {
          label: 'Remove Active Project from Registry',
          enabled: hasActiveProjectWebui,
          click: () => {
            if (active?.kind === 'project') void unregisterProject(active.root);
          },
        },
        { type: 'separator' },
        {
          label: 'New Session for Active Project',
          accelerator: 'CmdOrCtrl+N',
          enabled: hasActiveProjectWebui,
          click: () => void openProjectSession(active?.id),
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (hasActiveWebui) navigate({ view: 'settings' });
            else void openSettings();
          },
        },
        { type: 'separator' },
        {
          label: 'Close Active Runtime',
          accelerator: 'CmdOrCtrl+W',
          enabled: hasActiveRuntime,
          click: () => {
            const id = activeRuntimeId();
            if (id) void closeRuntime(id);
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'Projects',
      submenu: buildProjectsMenu(snapshot.runtimes, {
        activate: (runtimeId) => void activateRuntime(runtimeId),
        activateAndNavigate,
        newSession: (runtimeId) => void openProjectSession(runtimeId),
        openBrowser: (runtimeId) => {
          const url = manager.getRuntimeUrlWithToken(runtimeId);
          if (url) safeOpenExternal(url);
        },
        reload: reloadRuntimeWebui,
        close: (runtimeId) => void closeRuntime(runtimeId),
        reveal: (runtimeId) => {
          const runtime = manager.getRuntime(runtimeId);
          if (runtime) void shell.openPath(runtime.root);
        },
      }),
    },
    {
      label: 'Workspace',
      submenu: [
        webuiItem({ label: 'Open Chat', accelerator: 'CmdOrCtrl+1', click: () => navigate({ activity: 'chat', view: 'chat' }) }),
        webuiItem({ label: 'Focus Prompt', accelerator: 'CmdOrCtrl+/', click: () => navigate({ action: 'focus-chat' }) }),
        webuiItem({ label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => navigate({ terminal: 'toggle' }) }),
        webuiItem({ label: 'New Terminal', click: () => navigate({ terminal: 'new' }) }),
        { type: 'separator' },
        webuiItem({ label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => navigate({ action: 'open-command-palette' }) }),
        webuiItem({ label: 'Quick Model Switcher', accelerator: 'CmdOrCtrl+M', click: () => navigate({ action: 'open-model-switcher' }) }),
        webuiItem({
          type: 'checkbox',
          label: 'YOLO Mode',
          checked: yoloChecked,
          accelerator: 'CmdOrCtrl+Shift+Y',
          click: () => navigate({ pref: { key: 'yolo', toggle: true } }),
        }),
        webuiItem({
          type: 'checkbox',
          label: 'Next Prediction',
          checked: nextPredictionChecked,
          click: () => navigate({ pref: { key: 'nextPrediction', toggle: true } }),
        }),
        webuiItem({
          type: 'checkbox',
          label: 'Context Auto Compact',
          checked: contextAutoCompactChecked,
          click: () => navigate({ pref: { key: 'contextAutoCompact', toggle: true } }),
        }),
        { type: 'separator' },
        webuiItem({ label: 'Reload Active WebUI', accelerator: 'CmdOrCtrl+Shift+R', click: () => void reloadActiveWebuiView() }),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          type: 'checkbox',
          label: 'Compact Desktop Sidebar',
          accelerator: 'CmdOrCtrl+B',
          checked: shellSidebarCollapsed,
          click: () => setShellSidebarCollapsed(!shellSidebarCollapsed),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

manager.on('changed', () => {
  configureApplicationMenu();
  syncActiveWebuiView();
  broadcastState();
});

bridge.on('changed', (conversation) => {
  shellView?.webContents.send(IPC.conversationChanged, conversation);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quittingAfterCleanup) return;
  event.preventDefault();
  quittingAfterCleanup = true;
  if (saveWindowStateTimer) {
    clearTimeout(saveWindowStateTimer);
    saveWindowStateTimer = null;
  }
  bridge.closeAll();
  void saveWindowState()
    .catch(() => undefined)
    .finally(() => manager.closeAll({ persistWorkspace: false }).finally(() => app.quit()));
});

app
  .whenReady()
  .then(async () => {
    registerIpc();
    await createWindow();
    app.on('activate', () => {
      if (mainWindow === null) void createWindow();
    });
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });

function sameOrigin(candidate: string, base: string | null): boolean {
  if (!base) return false;
  try {
    const candidateUrl = new URL(candidate);
    const baseUrl = new URL(base);
    return candidateUrl.origin === baseUrl.origin;
  } catch {
    return false;
  }
}

function desktopSettingsWorkspaceRoot(): string {
  return path.join(wstackGlobalRoot(), 'desktop', 'global-settings-workspace');
}

function validatedWindowState(state: DesktopWindowState | null): DesktopWindowState | null {
  if (!state) return null;
  if (state.width < MIN_WINDOW_WIDTH || state.height < MIN_WINDOW_HEIGHT) return null;
  if (state.x === undefined || state.y === undefined) return state;
  const candidate = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  const visibleOnSomeDisplay = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return rectanglesIntersect(candidate, area);
  });
  return visibleOnSomeDisplay ? state : null;
}

function rectanglesIntersect(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
