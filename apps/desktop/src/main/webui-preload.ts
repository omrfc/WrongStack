import { contextBridge, ipcRenderer } from 'electron';
import type {
  WrongStackDesktopCommandApi,
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
  WrongStackDesktopHostApi,
} from '../shared/types.js';
import { IPC } from './ipc.js';

const api: WrongStackDesktopHostApi = {
  setReady: (ready: boolean) => {
    ipcRenderer.send(IPC.webuiReadyChanged, ready);
  },
  setPrefs: (prefs: DesktopWebuiPrefs) => {
    ipcRenderer.send(IPC.webuiPrefsChanged, prefs);
  },
  ackCommand: (requestId: string, handled: boolean, message?: string | undefined) => {
    ipcRenderer.send(IPC.webuiCommandAck, requestId, handled, message);
  },
};

const commandListeners = new Set<(command: DesktopWebuiCommand) => void>();
const commandApi: WrongStackDesktopCommandApi = {
  subscribe: (cb: (command: DesktopWebuiCommand) => void) => {
    commandListeners.add(cb);
    return () => {
      commandListeners.delete(cb);
    };
  },
};

ipcRenderer.on(IPC.webuiCommand, (_event, command: DesktopWebuiCommand) => {
  for (const listener of [...commandListeners]) {
    try {
      listener(command);
    } catch {
      /* The WebUI owns command handling errors. Keep the bridge alive. */
    }
  }
  window.dispatchEvent(
    new CustomEvent('wrongstack:desktop-command', {
      detail: command,
    }),
  );
});

contextBridge.exposeInMainWorld('wrongstackDesktopHost', api);
contextBridge.exposeInMainWorld('wrongstackDesktopCommands', commandApi);
