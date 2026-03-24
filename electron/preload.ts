import { contextBridge, ipcRenderer } from 'electron';

import type { LookoutApi } from '../src/types/electron-api';

const api: LookoutApi = {
  loadAppState: () => ipcRenderer.invoke('lookout:load-state'),
  saveAppState: (state) => ipcRenderer.invoke('lookout:save-state', state),
  listLocalFonts: () => ipcRenderer.invoke('lookout:list-local-fonts'),
  pickDirectory: (initialPath) => ipcRenderer.invoke('lookout:pick-directory', initialPath),
  validateDirectory: (inputPath) => ipcRenderer.invoke('lookout:validate-directory', inputPath),
  openPath: (inputPath) => ipcRenderer.invoke('lookout:open-path', inputPath),
  minimizeWindow: () => ipcRenderer.invoke('lookout:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('lookout:window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('lookout:window-close'),
  startTerminalSession: (request) => ipcRenderer.invoke('lookout:start-terminal', request),
  stopTerminalSession: (sessionId) => ipcRenderer.invoke('lookout:stop-terminal', sessionId),
  writeTerminalData: (sessionId, data) => ipcRenderer.invoke('lookout:write-terminal', { sessionId, data }),
  resizeTerminalSession: (sessionId, cols, rows) =>
    ipcRenderer.invoke('lookout:resize-terminal', { sessionId, cols, rows }),
  onTerminalEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload as never);
    ipcRenderer.on('lookout:terminal-event', listener);
    return () => ipcRenderer.removeListener('lookout:terminal-event', listener);
  },
};

contextBridge.exposeInMainWorld('lookout', api);
