// Every user-invokable action. Keybindings, the command palette and menus all
// refer to these ids. Commands that take arguments document them in `args`.

export const COMMANDS = {
  // Tabs & windows
  newTab: { title: 'New tab', category: 'Tabs', args: 'profile?: string (profile id)' },
  newTabProfileIndex: { title: 'New tab with profile #', category: 'Tabs', args: 'index: number (0-based)' },
  newTabMenu: { title: 'New tab…', category: 'Tabs' },
  duplicateTab: { title: 'Duplicate tab', category: 'Tabs' },
  closeTab: { title: 'Close tab', category: 'Tabs' },
  closeOtherTabs: { title: 'Close other tabs', category: 'Tabs' },
  reopenClosedTab: { title: 'Reopen closed tab', category: 'Tabs' },
  nextTab: { title: 'Next tab', category: 'Tabs' },
  prevTab: { title: 'Previous tab', category: 'Tabs' },
  switchToTab: { title: 'Switch to tab #', category: 'Tabs', args: 'index: number (0-based, -1 = last)' },
  renameTab: { title: 'Rename tab', category: 'Tabs' },
  moveTabToNewWindow: { title: 'Move tab to new window', category: 'Tabs' },
  newWindow: { title: 'New window', category: 'Window' },
  openAdminWindow: { title: 'Open administrator window', category: 'Window' },
  toggleSidebar: { title: 'Toggle sidebar', category: 'Window' },
  toggleFullscreen: { title: 'Toggle full screen', category: 'Window' },
  toggleQuake: { title: 'Toggle drop-down terminal', category: 'Window' },
  commandPalette: { title: 'Command palette', category: 'Window' },
  openSettings: { title: 'Settings', category: 'Window' },
  openSettingsJson: { title: 'Open settings file', category: 'Window' },
  toggleDevTools: { title: 'Toggle developer tools', category: 'Window' },
  quit: { title: 'Quit Lookout', category: 'Window' },

  // Panes
  splitRight: { title: 'Split pane right', category: 'Panes', args: 'profile?: string' },
  splitDown: { title: 'Split pane down', category: 'Panes', args: 'profile?: string' },
  splitAuto: { title: 'Duplicate pane (auto split)', category: 'Panes' },
  closePane: { title: 'Close pane', category: 'Panes' },
  focusPane: { title: 'Focus pane', category: 'Panes', args: "direction: 'left' | 'right' | 'up' | 'down'" },
  focusNextPane: { title: 'Focus next pane', category: 'Panes' },
  focusPrevPane: { title: 'Focus previous pane', category: 'Panes' },
  resizePane: { title: 'Resize pane', category: 'Panes', args: "direction: 'left' | 'right' | 'up' | 'down'" },
  equalizePanes: { title: 'Equalize pane sizes', category: 'Panes' },
  togglePaneZoom: { title: 'Toggle pane zoom', category: 'Panes' },
  movePaneToNewTab: { title: 'Move pane to new tab', category: 'Panes' },
  restartPane: { title: 'Restart pane', category: 'Panes' },
  toggleBroadcast: { title: 'Toggle broadcast input to all panes in tab', category: 'Panes' },

  // Terminal
  copy: { title: 'Copy', category: 'Terminal' },
  paste: { title: 'Paste', category: 'Terminal' },
  selectAll: { title: 'Select all', category: 'Terminal' },
  find: { title: 'Find', category: 'Terminal' },
  findNext: { title: 'Find next', category: 'Terminal' },
  findPrev: { title: 'Find previous', category: 'Terminal' },
  clearBuffer: { title: 'Clear buffer', category: 'Terminal' },
  scrollUp: { title: 'Scroll up one line', category: 'Terminal' },
  scrollDown: { title: 'Scroll down one line', category: 'Terminal' },
  scrollPageUp: { title: 'Scroll up one page', category: 'Terminal' },
  scrollPageDown: { title: 'Scroll down one page', category: 'Terminal' },
  scrollToTop: { title: 'Scroll to top', category: 'Terminal' },
  scrollToBottom: { title: 'Scroll to bottom', category: 'Terminal' },
  prevCommand: { title: 'Go to previous command', category: 'Terminal' },
  nextCommand: { title: 'Go to next command', category: 'Terminal' },
  copyLastCommandOutput: { title: 'Copy last command output', category: 'Terminal' },
  selectLastCommandOutput: { title: 'Select last command output', category: 'Terminal' },
  fontSizeIncrease: { title: 'Increase font size', category: 'Terminal' },
  fontSizeDecrease: { title: 'Decrease font size', category: 'Terminal' },
  fontSizeReset: { title: 'Reset font size', category: 'Terminal' },
  runSnippet: { title: 'Run snippet', category: 'Terminal', args: 'id: string' },
  sendInput: { title: 'Send text to the terminal', category: 'Terminal', args: 'input: string' },

  // Folders & workspaces
  openInExplorer: { title: 'Open folder in Explorer', category: 'Folder' },
  openInVSCode: { title: 'Open folder in VS Code', category: 'Folder' },
  copyCwd: { title: 'Copy current folder path', category: 'Folder' },
  saveWorkspace: { title: 'Save tab as workspace', category: 'Workspaces' },
  openWorkspace: { title: 'Open workspace', category: 'Workspaces', args: 'id: string' },
} as const satisfies Record<string, { title: string; category: string; args?: string }>;

export type CommandId = keyof typeof COMMANDS;

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && value in COMMANDS;
}
