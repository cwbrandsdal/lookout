import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { HOST_PORT_MESSAGE, type LookoutBridge } from '../src/shared/ipc';

// The pty host port cannot cross contextBridge; forward it to the page with
// window.postMessage (transferable), where the renderer picks it up.
ipcRenderer.on(HOST_PORT_MESSAGE, (event) => {
  window.postMessage(HOST_PORT_MESSAGE, '*', event.ports);
});

function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args));
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: LookoutBridge = {
  bootstrap: () => ipcRenderer.invoke('lookout:bootstrap'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  minimize: () => ipcRenderer.send('lookout:minimize'),
  toggleMaximize: () => ipcRenderer.send('lookout:toggle-maximize'),
  close: () => ipcRenderer.send('lookout:close'),
  setFullscreen: (enabled) => ipcRenderer.send('lookout:set-fullscreen', enabled),
  toggleDevTools: () => ipcRenderer.send('lookout:toggle-devtools'),
  setProgress: (progress) => ipcRenderer.send('lookout:set-progress', progress),
  flashFrame: () => ipcRenderer.send('lookout:flash-frame'),
  setTitle: (title) => ipcRenderer.send('lookout:set-title', title),
  onWindowFlags: (listener) => subscribe('lookout:window-flags', listener),
  onCloseRequested: (listener) => subscribe('lookout:close-requested', listener),
  closeConfirmed: () => ipcRenderer.send('lookout:close-confirmed'),
  saveWindow: (spec) => ipcRenderer.send('lookout:save-window', spec),
  newWindow: (actions) => ipcRenderer.send('lookout:new-window', actions),
  moveTabToNewWindow: (tab, sessions, screenPoint) => ipcRenderer.send('lookout:move-tab-to-new-window', tab, sessions, screenPoint),
  openAdminWindow: (actions) => ipcRenderer.send('lookout:open-admin-window', actions),
  toggleQuake: () => ipcRenderer.send('lookout:toggle-quake'),
  reportKeyboardLayout: (backquoteKey) => ipcRenderer.send('lookout:keyboard-layout', backquoteKey),
  quit: () => ipcRenderer.send('lookout:quit'),
  onAction: (listener) => subscribe('lookout:action', listener),
  requestHostPort: () => ipcRenderer.send('lookout:request-host-port'),

  setSettings: (next) => ipcRenderer.invoke('lookout:set-settings', next),
  onSettings: (listener) => subscribe('lookout:settings', listener),
  openSettingsFile: () => ipcRenderer.send('lookout:open-settings-file'),
  redetectProfiles: () => ipcRenderer.invoke('lookout:redetect-profiles'),
  importWindowsTerminal: () => ipcRenderer.invoke('lookout:import-wt'),
  listFonts: () => ipcRenderer.invoke('lookout:list-fonts'),

  getRestoredBuffer: (paneId) => ipcRenderer.invoke('lookout:get-restored-buffer', paneId),
  saveWorkspace: (workspace) => ipcRenderer.send('lookout:save-workspace', workspace),
  deleteWorkspace: (id) => ipcRenderer.send('lookout:delete-workspace', id),
  onWorkspaces: (listener) => subscribe('lookout:workspaces', listener),
  addRecentDirectory: (dir) => ipcRenderer.send('lookout:add-recent-directory', dir),
  onRecentDirectories: (listener) => subscribe('lookout:recent-directories', listener),
  pushClosedTab: (tab) => ipcRenderer.send('lookout:push-closed-tab', tab),
  popClosedTab: () => ipcRenderer.invoke('lookout:pop-closed-tab'),

  openPath: (target) => ipcRenderer.send('lookout:open-path', target),
  openExternal: (url) => ipcRenderer.send('lookout:open-external', url),
  showItemInFolder: (target) => ipcRenderer.send('lookout:show-item-in-folder', target),
  openInVSCode: (target, line, column) => ipcRenderer.send('lookout:open-in-vscode', target, line, column),
  probePaths: (inputs, cwd) => ipcRenderer.invoke('lookout:probe-paths', inputs, cwd),
  notify: (request) => ipcRenderer.send('lookout:notify', request),
  beep: () => ipcRenderer.send('lookout:beep'),

  gitWatch: (cwd) => ipcRenderer.send('lookout:git-watch', cwd),
  gitUnwatch: (cwd) => ipcRenderer.send('lookout:git-unwatch', cwd),
  gitRefresh: (cwd) => ipcRenderer.send('lookout:git-refresh', cwd),
  onGit: (listener) => subscribe('lookout:git', listener),

  getIntegrations: () => ipcRenderer.invoke('lookout:get-integrations'),
  setIntegration: (id, enabled) => ipcRenderer.invoke('lookout:set-integration', id, enabled),

  getUpdateState: () => ipcRenderer.invoke('lookout:get-update-state'),
  checkForUpdates: () => ipcRenderer.send('lookout:check-for-updates'),
  downloadUpdate: () => ipcRenderer.send('lookout:download-update'),
  installUpdate: () => ipcRenderer.send('lookout:install-update'),
  onUpdateState: (listener) => subscribe('lookout:update-state', listener),
};

contextBridge.exposeInMainWorld('lookout', bridge);
