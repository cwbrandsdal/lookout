// Labels and descriptions of every searchable setting. Rows look their text up here,
// so the settings search and the rendered rows can never disagree.

export type SectionId = 'general' | 'appearance' | 'terminal' | 'profiles' | 'keyboard' | 'snippets' | 'integrations' | 'about';

export const SECTIONS: ReadonlyArray<{ id: SectionId; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'terminal', title: 'Terminal' },
  { id: 'profiles', title: 'Profiles' },
  { id: 'keyboard', title: 'Keyboard' },
  { id: 'snippets', title: 'Snippets' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'about', title: 'About' },
];

export function isSectionId(value: unknown): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

export interface SettingMeta {
  section: SectionId;
  group?: string;
  label: string;
  description?: string;
  keywords?: string;
}

export const ROWS = {
  // General
  'general.defaultProfile': { section: 'general', label: 'Default profile', description: 'Opened by new tabs, Ctrl+Shift+T and the lookout command.', keywords: 'shell startup' },
  'general.newTabDirectory': { section: 'general', label: 'New tab folder', description: 'Where new tabs and splits start.', keywords: 'directory cwd working inherit' },
  'general.restoreSession': { section: 'general', group: 'Session', label: 'Restore tabs on launch', description: 'Reopen the windows, tabs and panes from last time.', keywords: 'session startup' },
  'general.restoreBuffers': { section: 'general', group: 'Session', label: 'Restore scrollback', description: 'Bring back terminal output in restored panes.', keywords: 'buffer history output' },
  'general.confirmCloseRunning': { section: 'general', group: 'Session', label: 'Confirm before closing running processes', description: 'Ask before closing a pane, tab or window with a command still running.', keywords: 'close warn prompt' },
  'general.keepRunningInTray': { section: 'general', group: 'Window', label: 'Keep running in the tray', description: 'Closing the last window leaves Lookout in the notification area.', keywords: 'background minimize' },
  'general.launchOnLogin': { section: 'general', group: 'Window', label: 'Launch on login', description: 'Start in the tray when you sign in to Windows.', keywords: 'startup boot autostart' },
  'general.paneHeaders': { section: 'general', group: 'Window', label: 'Pane headers', description: 'Auto shows them only when a tab has more than one pane.', keywords: 'title bar split' },
  'general.gitStatus': { section: 'general', group: 'Window', label: 'Git status in tabs', description: 'Branch and pending changes for the folder of each tab.', keywords: 'branch repository' },
  'general.notificationsEnabled': { section: 'general', group: 'Notifications', label: 'Notify when long commands finish', description: 'A Windows notification with the command and its exit code.', keywords: 'toast alert done' },
  'general.longCommandSeconds': { section: 'general', group: 'Notifications', label: 'Long command threshold', description: 'Commands that run at least this long trigger a notification.', keywords: 'duration seconds' },
  'general.onlyWhenUnfocused': { section: 'general', group: 'Notifications', label: 'Only when Lookout is in the background', description: 'Skip the notification while you are looking at the pane.', keywords: 'focus' },
  'general.quakeEnabled': { section: 'general', group: 'Global hotkeys', label: 'Drop-down terminal', description: 'A terminal that slides down from the top of the screen.', keywords: 'quake dropdown' },
  'general.quakeHotkey': { section: 'general', group: 'Global hotkeys', label: 'Drop-down hotkey', description: 'Global shortcut that shows or hides the drop-down terminal.', keywords: 'quake shortcut global' },
  'general.quakeHeight': { section: 'general', group: 'Global hotkeys', label: 'Drop-down height', description: 'Share of the screen height.', keywords: 'quake size percent' },
  'general.summonHotkey': { section: 'general', group: 'Global hotkeys', label: 'Summon hotkey', description: 'Global shortcut that brings the last Lookout window to the front.', keywords: 'global focus show activate' },

  // Appearance
  'appearance.appTheme': { section: 'appearance', label: 'App theme', description: 'Lookout chrome. System follows Windows.', keywords: 'dark light mode' },
  'appearance.darkTheme': {
    section: 'appearance',
    label: 'Dark theme',
    description: 'How dark Lookout is when the app theme is dark. Also switches the terminal colors if they use a Lookout scheme.',
    keywords: 'night dusk slate ash brightness lighter darker contrast',
  },
  'appearance.preview': { section: 'appearance', group: 'Preview', label: 'Preview', description: 'The selected color scheme and font.', keywords: 'sample' },
  'appearance.fontFace': { section: 'appearance', group: 'Font', label: 'Font face', description: 'Nerd Fonts: pick the “Mono” variant, not “Propo”.', keywords: 'family typeface nerd' },
  'appearance.fontSize': { section: 'appearance', group: 'Font', label: 'Font size', description: 'In pixels.', keywords: 'zoom' },
  'appearance.lineHeight': { section: 'appearance', group: 'Font', label: 'Line height', description: 'Multiple of the font size; 1 is the tightest.', keywords: 'spacing' },
  'appearance.letterSpacing': { section: 'appearance', group: 'Font', label: 'Letter spacing', description: 'Extra pixels between characters.', keywords: 'tracking' },
  'appearance.fontWeight': { section: 'appearance', group: 'Font', label: 'Font weight', keywords: 'thin light' },
  'appearance.fontWeightBold': { section: 'appearance', group: 'Font', label: 'Bold weight', description: 'Used for bold text.', keywords: 'bright' },
  'appearance.cursorStyle': { section: 'appearance', group: 'Cursor', label: 'Cursor shape', keywords: 'bar block underline caret' },
  'appearance.cursorBlink': { section: 'appearance', group: 'Cursor', label: 'Blinking cursor', keywords: 'caret' },
  'appearance.colorScheme': { section: 'appearance', group: 'Color scheme', label: 'Color scheme', description: 'Used by every profile without its own scheme.', keywords: 'theme palette colors itermcolors import' },
  'appearance.minimumContrastRatio': { section: 'appearance', group: 'Rendering', label: 'Minimum contrast ratio', description: '1 = automatic (fixes unreadable colors, like Windows Terminal); 4.5 meets WCAG AA.', keywords: 'accessibility readability' },
  'appearance.gpu': { section: 'appearance', group: 'Rendering', label: 'GPU acceleration', description: 'Render with WebGL. Turn off if text looks corrupted.', keywords: 'webgl hardware' },
  'appearance.unicodeVersion': { section: 'appearance', group: 'Rendering', label: 'Character width', description: 'Graphemes handles emoji sequences; Unicode 11 matches most shells.', keywords: 'emoji unicode wide' },

  // Terminal
  'terminal.scrollback': { section: 'terminal', label: 'Scrollback', description: 'Lines kept per pane.', keywords: 'history buffer lines' },
  'terminal.copyOnSelect': { section: 'terminal', group: 'Clipboard', label: 'Copy on select', description: 'Selecting text copies it immediately.', keywords: 'clipboard' },
  'terminal.copyFormatting': { section: 'terminal', group: 'Clipboard', label: 'Copy with formatting', description: 'Also put colored HTML on the clipboard.', keywords: 'html rich' },
  'terminal.trimTrailingWhitespace': { section: 'terminal', group: 'Clipboard', label: 'Trim trailing whitespace', description: 'Strip spaces at line ends when copying.', keywords: 'copy' },
  'terminal.rightClick': { section: 'terminal', group: 'Clipboard', label: 'Right-click', description: 'Copy the selection or paste, or open the context menu.', keywords: 'mouse context menu' },
  'terminal.middleClickPaste': { section: 'terminal', group: 'Clipboard', label: 'Middle-click paste', keywords: 'mouse' },
  'terminal.autoSubmitSingleLinePaste': { section: 'terminal', group: 'Clipboard', label: 'Auto-submit single-line paste', description: 'Let a trailing line break submit a pasted single-line command. Off requires pressing Enter.', keywords: 'send execute run newline' },
  'terminal.warnMultilinePaste': { section: 'terminal', group: 'Clipboard', label: 'Warn on multi-line paste', description: 'Confirm before pasting text that would run several commands.', keywords: 'newline' },
  'terminal.warnLargePasteBytes': { section: 'terminal', group: 'Clipboard', label: 'Warn on large paste', description: 'Confirm pastes larger than this; 0 turns it off.', keywords: 'size bytes' },
  'terminal.wordSeparators': { section: 'terminal', group: 'Selection and links', label: 'Word separators', description: 'Characters that end a double-click selection.', keywords: 'delimiters double click' },
  'terminal.linkRequiresCtrl': { section: 'terminal', group: 'Selection and links', label: 'Ctrl+click opens links', description: 'Off opens links and paths on a plain click.', keywords: 'url hyperlink path' },
  'terminal.bellSound': { section: 'terminal', group: 'Bell', label: 'Sound', description: 'Play the Windows notification sound.', keywords: 'bell beep audible' },
  'terminal.bellVisual': { section: 'terminal', group: 'Bell', label: 'Flash the pane', keywords: 'bell visual' },
  'terminal.bellTaskbar': { section: 'terminal', group: 'Bell', label: 'Flash the taskbar button', description: 'Only while the window is in the background.', keywords: 'bell attention' },
  'terminal.closeOnExit': { section: 'terminal', group: 'Behavior', label: 'When a shell exits', description: 'Graceful closes on success and keeps the pane open after errors.', keywords: 'close exit code' },
  'terminal.smoothScroll': { section: 'terminal', group: 'Behavior', label: 'Smooth scrolling', description: 'Animate mouse-wheel scrolling.', keywords: 'wheel' },

  // List sections (search jumps to them)
  'profiles.list': {
    section: 'profiles',
    label: 'Profiles',
    description: 'Shells you can open; their order sets Ctrl+Shift+1…9.',
    keywords: 'shell commandline powershell pwsh cmd wsl ssh git bash environment variables starting directory startup command administrator elevate tab color icon hidden detect import windows terminal',
  },
  'keyboard.shortcuts': { section: 'keyboard', label: 'Keyboard shortcuts', description: 'Add, remove and reset the keys for every command.', keywords: 'keybindings keys chords hotkeys' },
  'snippets.list': { section: 'snippets', label: 'Snippets', description: 'Saved commands you can run from the command palette.', keywords: 'commands macros text' },

  // Integrations
  'integrations.defaultTerminal': { section: 'integrations', label: 'Default terminal app', description: 'Console programs that open their own window open in Lookout.', keywords: 'console conhost delegation windows' },
  'integrations.explorerMenu': { section: 'integrations', label: '“Open in Lookout” in Explorer', description: 'Adds the entry to folder and folder-background menus.', keywords: 'context menu right click shell' },
  'integrations.cliOnPath': { section: 'integrations', label: '“lookout” command on PATH', description: 'Open tabs, splits and windows from any shell.', keywords: 'cli command line wt' },
  'integrations.admin': { section: 'integrations', group: 'Administrator', label: 'Administrator window', description: 'A separate elevated window for admin shells.', keywords: 'elevated admin uac' },

  // About
  'about.version': { section: 'about', label: 'Version', keywords: 'build' },
  'about.updates': { section: 'about', label: 'Updates', keywords: 'upgrade release download install' },
  'about.settingsFile': { section: 'about', label: 'Settings file', description: 'Edits to the file apply as soon as you save it.', keywords: 'settings.json json path' },
  'about.elevation': { section: 'about', label: 'Elevation', keywords: 'administrator admin uac' },
} as const satisfies Record<string, SettingMeta>;

export type RowId = keyof typeof ROWS;

export function rowMeta(id: RowId): SettingMeta {
  return ROWS[id];
}

export const ROW_IDS = Object.keys(ROWS) as RowId[];

/** Lowercased whitespace-separated terms; every term must appear somewhere in `haystack`. */
export function matchesTerms(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}

export function matchRows(query: string): Set<RowId> {
  const result = new Set<RowId>();
  if (!query.trim()) {
    return result;
  }
  for (const id of ROW_IDS) {
    const meta = rowMeta(id);
    if (matchesTerms([meta.label, meta.description, meta.keywords, meta.group].filter(Boolean).join(' '), query)) {
      result.add(id);
    }
  }
  return result;
}
