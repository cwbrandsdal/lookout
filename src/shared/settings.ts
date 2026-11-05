// User-facing settings (settings.json). Shared by the Electron main process,
// the pty host and the renderer, so keep this file free of DOM/Node imports.

import type { DarkTheme } from './themes';

export type { DarkTheme } from './themes';

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'wsl' | 'ssh' | 'other';

export type CursorStyle = 'bar' | 'block' | 'underline';
export type CloseOnExit = 'graceful' | 'always' | 'never';
export type ProfileSource = 'detected' | 'windows-terminal' | 'user' | 'migrated';

export interface FontSettings {
  face: string;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  weight: 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
  weightBold: 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
}

export interface ProfileDefinition {
  /** Stable id. Detected profiles use a deterministic slug (e.g. `pwsh`, `wsl-ubuntu`, `ssh-devbox`). */
  id: string;
  name: string;
  /**
   * Full Windows command line, e.g. `pwsh.exe -NoLogo` or
   * `C:\Windows\System32\OpenSSH\ssh.exe user@host`. `%VAR%` references are
   * expanded at launch time.
   */
  commandline: string;
  /** Directory to start in. `%VAR%` and `~` are expanded. Undefined means the user's home. */
  startingDirectory?: string;
  /** Typed into the shell once it is ready (implemented via shell launch args where possible). */
  startupCommand?: string;
  /** Single glyph or short text shown in menus/tabs (emoji, Nerd Font glyph or 1-2 letters). */
  icon?: string;
  /** Derived from the commandline when absent. */
  shellKind?: ShellKind;
  colorScheme?: string;
  font?: Partial<FontSettings>;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  env?: Record<string, string>;
  hidden?: boolean;
  source?: ProfileSource;
  /** Windows Terminal profile guid this profile was imported from, if any. */
  wtGuid?: string;
  /** Open in an elevated (administrator) Lookout window. */
  elevate?: boolean;
  /** Inject Lookout shell integration (cwd tracking, command marks). Default true. */
  shellIntegration?: boolean;
  closeOnExit?: CloseOnExit;
  tabColor?: string;
}

/** Windows Terminal compatible color scheme (same key names as WT `schemes`). */
export interface ColorScheme {
  name: string;
  foreground: string;
  background: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * `keys` uses lowercase `+`-joined chords: `ctrl+shift+t`, `alt+shift+minus`,
 * `ctrl+plus`, `shift+pageup`, `f11`. `command: null` unbinds a default.
 */
export interface KeybindingEntry {
  keys: string;
  command: string | null;
  args?: Record<string, string | number | boolean>;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Append Enter after inserting. */
  run: boolean;
}

export interface BellSettings {
  sound: boolean;
  visual: boolean;
  taskbar: boolean;
}

export interface TerminalBehaviorSettings {
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  copyFormatting: boolean;
  trimTrailingWhitespace: boolean;
  rightClick: 'copyPaste' | 'menu';
  middleClickPaste: boolean;
  wordSeparators: string;
  bell: BellSettings;
  warnMultilinePaste: boolean;
  warnLargePasteBytes: number;
  linkRequiresCtrl: boolean;
  unicodeVersion: '11' | 'graphemes';
  gpuAcceleration: 'auto' | 'off';
  minimumContrastRatio: number;
  smoothScroll: boolean;
  closeOnExit: CloseOnExit;
}

export interface WindowBehaviorSettings {
  /** Where new tabs start: the focused pane's folder, or the profile's starting directory. */
  newTabDirectory: 'inherit' | 'profile';
  confirmCloseRunning: boolean;
  paneHeaders: 'auto' | 'always' | 'never';
  restoreSession: boolean;
  restoreBuffers: boolean;
  keepRunningInTray: boolean;
  launchOnLogin: boolean;
  summonHotkey: string | null;
}

export interface QuakeSettings {
  enabled: boolean;
  hotkey: string;
  heightPercent: number;
}

export interface NotificationSettings {
  enabled: boolean;
  longCommandSeconds: number;
  onlyWhenUnfocused: boolean;
}

export interface LookoutSettings {
  version: 2;
  defaultProfile: string;
  profiles: ProfileDefinition[];
  font: FontSettings;
  colorScheme: string;
  /** User-defined or imported schemes; built-in schemes are always available in addition. */
  schemes: ColorScheme[];
  appTheme: 'system' | 'dark' | 'light';
  /** Which dark variant the window uses whenever the app theme is dark. */
  darkTheme: DarkTheme;
  /** User overrides merged on top of the default keymap. */
  keybindings: KeybindingEntry[];
  snippets: Snippet[];
  terminal: TerminalBehaviorSettings;
  window: WindowBehaviorSettings;
  quake: QuakeSettings;
  notifications: NotificationSettings;
  gitStatus: boolean;
}
