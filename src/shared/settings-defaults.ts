// Default settings and the settings.json sanitizer. Pure (no DOM/Node imports)
// so the main process, pty host and renderer can all use it.

import { findScheme } from './color-schemes';
import { isCommandId } from './commands';
import { DARK_THEMES, DEFAULT_DARK_THEME } from './themes';
import type {
  BellSettings,
  CloseOnExit,
  ColorScheme,
  CursorStyle,
  FontSettings,
  KeybindingEntry,
  LookoutSettings,
  NotificationSettings,
  ProfileDefinition,
  ProfileSource,
  QuakeSettings,
  ShellKind,
  Snippet,
  TerminalBehaviorSettings,
  WindowBehaviorSettings,
} from './settings';

/**
 * WT's default is ` /\()"'-.,:;<>~!@#$%^&*|+=[]{}~?\u2502` (TerminalSettingsModel/defaults.json).
 * Lookout keeps the bracket/quote/punctuation set and WT's box-drawing U+2502, but not
 * `/ \ . : - ~ @ = + ? & %`, so a double-click selects a whole path or URL.
 */
export const DEFAULT_WORD_SEPARATORS = ' ()[]{}\'",;<>|\u2502';

export const DEFAULT_COLOR_SCHEME = 'Lookout Night';
export const DEFAULT_FONT_FACE = 'Cascadia Mono';

/** Numeric ranges enforced by `sanitizeSettings` (also useful for settings UI controls). */
export const SETTINGS_LIMITS = {
  fontSize: { min: 6, max: 72 },
  // xterm.js rejects line heights below 1.
  lineHeight: { min: 1, max: 3 },
  letterSpacing: { min: -5, max: 20 },
  scrollback: { min: 0, max: 200_000 },
  warnLargePasteBytes: { min: 0, max: 100 * 1024 * 1024 },
  minimumContrastRatio: { min: 1, max: 21 },
  quakeHeightPercent: { min: 10, max: 100 },
  longCommandSeconds: { min: 1, max: 86_400 },
} as const;

const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const CURSOR_STYLES: readonly CursorStyle[] = ['bar', 'block', 'underline'];
const CLOSE_ON_EXIT: readonly CloseOnExit[] = ['graceful', 'always', 'never'];
const SHELL_KINDS: readonly ShellKind[] = ['pwsh', 'powershell', 'cmd', 'bash', 'wsl', 'ssh', 'other'];
const PROFILE_SOURCES: readonly ProfileSource[] = ['detected', 'windows-terminal', 'user', 'migrated'];
const SCHEME_COLOR_KEYS = [
  'foreground', 'background',
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
] as const;
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
  meta: 'meta', win: 'meta', windows: 'meta', super: 'meta', cmd: 'meta',
};

/** Ids of the fallback profiles, in default-profile preference order. */
export const FALLBACK_PROFILE_IDS = ['pwsh', 'windows-powershell', 'cmd'] as const;

function createFallbackProfiles(): ProfileDefinition[] {
  // `source: 'detected'` so `mergeDetectedProfiles` hides any of these that detection
  // later fails to find (e.g. pwsh not installed).
  return [
    { id: 'pwsh', name: 'PowerShell', commandline: 'pwsh.exe', shellKind: 'pwsh', source: 'detected' },
    {
      id: 'windows-powershell',
      name: 'Windows PowerShell',
      commandline: '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      shellKind: 'powershell',
      source: 'detected',
    },
    { id: 'cmd', name: 'Command Prompt', commandline: '%SystemRoot%\\System32\\cmd.exe', shellKind: 'cmd', source: 'detected' },
  ];
}

export function createDefaultSettings(): LookoutSettings {
  return {
    version: 2,
    defaultProfile: 'pwsh',
    profiles: createFallbackProfiles(),
    font: {
      face: DEFAULT_FONT_FACE,
      size: 13,
      lineHeight: 1.1,
      letterSpacing: 0,
      weight: 'normal',
      weightBold: 'bold',
    },
    colorScheme: DEFAULT_COLOR_SCHEME,
    schemes: [],
    appTheme: 'dark',
    darkTheme: DEFAULT_DARK_THEME,
    keybindings: [],
    snippets: [],
    terminal: {
      scrollback: 10_000,
      cursorStyle: 'bar',
      cursorBlink: true,
      copyOnSelect: false,
      copyFormatting: false,
      trimTrailingWhitespace: true,
      rightClick: 'copyPaste',
      middleClickPaste: false,
      wordSeparators: DEFAULT_WORD_SEPARATORS,
      bell: { sound: false, visual: true, taskbar: true },
      autoSubmitSingleLinePaste: false,
      warnMultilinePaste: true,
      warnLargePasteBytes: 5120,
      linkRequiresCtrl: true,
      unicodeVersion: '11',
      gpuAcceleration: 'auto',
      minimumContrastRatio: 1,
      smoothScroll: false,
      closeOnExit: 'graceful',
    },
    window: {
      newTabDirectory: 'inherit',
      confirmCloseRunning: true,
      paneHeaders: 'auto',
      restoreSession: true,
      restoreBuffers: true,
      keepRunningInTray: true,
      launchOnLogin: false,
      summonHotkey: null,
    },
    quake: { enabled: true, hotkey: 'Super+`', heightPercent: 45 },
    notifications: { enabled: true, longCommandSeconds: 10, onlyWhenUnfocused: true },
    gitStatus: true,
  };
}

// ---- Sanitizer --------------------------------------------------------------

type Obj = Record<string, unknown>;

interface NumberRange {
  min: number;
  max: number;
  integer?: boolean;
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'object') return 'an object';
  return String(value);
}

/** Reads typed fields from an untrusted object, recording a warning for each bad value. */
class Reader {
  readonly warnings: string[];

  constructor(warnings: string[]) {
    this.warnings = warnings;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  bool(input: Obj, key: string, fallback: boolean, path: string): boolean {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    this.warn(`${path}.${key}: expected true/false, got ${describe(value)}.`);
    return fallback;
  }

  num(input: Obj, key: string, fallback: number, range: NumberRange, path: string): number {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.warn(`${path}.${key}: expected a number, got ${describe(value)}.`);
      return fallback;
    }

    let result = range.integer ? Math.round(value) : value;
    if (result < range.min || result > range.max) {
      result = Math.min(range.max, Math.max(range.min, result));
      this.warn(`${path}.${key}: ${value} is outside ${range.min}..${range.max}; using ${result}.`);
    }
    return result;
  }

  str(input: Obj, key: string, fallback: string, path: string, allowEmpty = false): string {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (allowEmpty || value.trim())) return allowEmpty ? value : value.trim();
    this.warn(`${path}.${key}: expected a${allowEmpty ? '' : ' non-empty'} string, got ${describe(value)}.`);
    return fallback;
  }

  oneOf<T extends string>(input: Obj, key: string, allowed: readonly T[], fallback: T, path: string): T {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.warn(`${path}.${key}: expected one of ${allowed.map((entry) => `'${entry}'`).join(', ')}, got ${describe(value)}.`);
    return fallback;
  }

  obj(input: Obj, key: string, path: string): Obj {
    const value = input[key];
    if (value === undefined) return {};
    if (isObj(value)) return value;
    this.warn(`${path}.${key}: expected an object, got ${describe(value)}.`);
    return {};
  }

  /** Optional field: returns undefined when absent or invalid. */
  optional<T>(input: Obj, key: string, path: string, check: (value: unknown) => T | undefined, expected: string): T | undefined {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    const result = check(value);
    if (result === undefined) this.warn(`${path}.${key}: expected ${expected}, got ${describe(value)}.`);
    return result;
  }
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`, normalized to lowercase (3-digit expanded). */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^#[\da-f]{3}$/i.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((digit) => digit + digit).join('')}`.toLowerCase();
  }
  return /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let index = 2; used.has(id.toLowerCase()); index += 1) id = `${base}-${index}`;
  used.add(id.toLowerCase());
  return id;
}

function stringRecord(value: unknown, path: string, reader: Reader): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObj(value)) {
    reader.warn(`${path}: expected an object of strings, got ${describe(value)}.`);
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
    else reader.warn(`${path}.${key}: expected a string, got ${describe(entry)}.`);
  }
  return result;
}

function sanitizeFont(input: unknown, base: FontSettings, path: string, reader: Reader): FontSettings {
  if (input !== undefined && !isObj(input)) reader.warn(`${path}: expected an object, got ${describe(input)}.`);
  const font = isObj(input) ? input : {};
  return {
    face: reader.str(font, 'face', base.face, path),
    size: reader.num(font, 'size', base.size, SETTINGS_LIMITS.fontSize, path),
    lineHeight: reader.num(font, 'lineHeight', base.lineHeight, SETTINGS_LIMITS.lineHeight, path),
    letterSpacing: reader.num(font, 'letterSpacing', base.letterSpacing, SETTINGS_LIMITS.letterSpacing, path),
    weight: reader.oneOf(font, 'weight', FONT_WEIGHTS, base.weight, path),
    weightBold: reader.oneOf(font, 'weightBold', FONT_WEIGHTS, base.weightBold, path),
  };
}

function sanitizePartialFont(input: unknown, path: string, reader: Reader): Partial<FontSettings> | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isObj(input)) {
    reader.warn(`${path}: expected an object, got ${describe(input)}.`);
    return undefined;
  }

  const result: Partial<FontSettings> = {};
  const face = reader.optional(input, 'face', path, nonEmptyString, 'a non-empty string');
  if (face) result.face = face;
  const limits = { size: SETTINGS_LIMITS.fontSize, lineHeight: SETTINGS_LIMITS.lineHeight, letterSpacing: SETTINGS_LIMITS.letterSpacing };
  for (const key of ['size', 'lineHeight', 'letterSpacing'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reader.warn(`${path}.${key}: expected a number, got ${describe(value)}.`);
      continue;
    }
    result[key] = reader.num(input, key, value, limits[key], path);
  }
  for (const key of ['weight', 'weightBold'] as const) {
    const weight = reader.optional(input, key, path, (value) => (FONT_WEIGHTS as readonly unknown[]).includes(value) ? value as FontSettings['weight'] : undefined, 'a font weight');
    if (weight) result[key] = weight;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeProfile(input: unknown, index: number, usedIds: Set<string>, reader: Reader): ProfileDefinition | null {
  const label = `profiles[${index}]`;
  if (!isObj(input)) {
    reader.warn(`${label}: expected a profile object; it was removed.`);
    return null;
  }

  const commandline = nonEmptyString(input.commandline);
  const rawId = nonEmptyString(input.id);
  const name = nonEmptyString(input.name);
  if (!commandline) {
    reader.warn(`${label} (${rawId ?? name ?? 'unnamed'}): no commandline; the profile was removed.`);
    return null;
  }
  if (!rawId && !name) {
    reader.warn(`${label}: a profile needs an id or a name; it was removed.`);
    return null;
  }

  const baseId = rawId ?? (slug(name!) || 'profile');
  const id = uniqueId(baseId, usedIds);
  if (rawId && id !== rawId) reader.warn(`${label}: duplicate profile id "${rawId}" was renamed to "${id}".`);

  const path = `profiles.${id}`;
  const profile: ProfileDefinition = { id, name: name ?? id, commandline };
  const text = (key: 'startingDirectory' | 'startupCommand' | 'icon' | 'colorScheme' | 'wtGuid') => {
    const value = reader.optional(input, key, path, nonEmptyString, 'a non-empty string');
    if (value !== undefined) profile[key] = value;
  };
  text('startingDirectory');
  text('startupCommand');
  text('icon');
  text('colorScheme');
  text('wtGuid');

  const shellKind = reader.optional(input, 'shellKind', path, (value) => (SHELL_KINDS as readonly unknown[]).includes(value) ? value as ShellKind : undefined, 'a shell kind');
  if (shellKind) profile.shellKind = shellKind;
  const font = sanitizePartialFont(input.font, `${path}.font`, reader);
  if (font) profile.font = font;
  const cursorStyle = reader.optional(input, 'cursorStyle', path, (value) => (CURSOR_STYLES as readonly unknown[]).includes(value) ? value as CursorStyle : undefined, "'bar', 'block' or 'underline'");
  if (cursorStyle) profile.cursorStyle = cursorStyle;
  for (const key of ['cursorBlink', 'hidden', 'elevate', 'shellIntegration'] as const) {
    const value = reader.optional(input, key, path, (entry) => typeof entry === 'boolean' ? entry : undefined, 'true/false');
    if (value !== undefined) profile[key] = value;
  }
  const env = stringRecord(input.env, `${path}.env`, reader);
  if (env) profile.env = env;
  const source = reader.optional(input, 'source', path, (value) => (PROFILE_SOURCES as readonly unknown[]).includes(value) ? value as ProfileSource : undefined, 'a profile source');
  if (source) profile.source = source;
  const closeOnExit = reader.optional(input, 'closeOnExit', path, (value) => (CLOSE_ON_EXIT as readonly unknown[]).includes(value) ? value as CloseOnExit : undefined, "'graceful', 'always' or 'never'");
  if (closeOnExit) profile.closeOnExit = closeOnExit;
  const tabColor = reader.optional(input, 'tabColor', path, normalizeColor, 'a #rrggbb color');
  if (tabColor) profile.tabColor = tabColor;
  return profile;
}

function sanitizeScheme(input: unknown, index: number, reader: Reader): ColorScheme | null {
  if (!isObj(input)) {
    reader.warn(`schemes[${index}]: expected a color scheme object; it was removed.`);
    return null;
  }

  const name = nonEmptyString(input.name);
  if (!name) {
    reader.warn(`schemes[${index}]: a color scheme needs a name; it was removed.`);
    return null;
  }

  const scheme: Partial<ColorScheme> = { name };
  const invalid: string[] = [];
  for (const key of SCHEME_COLOR_KEYS) {
    const color = normalizeColor(input[key]);
    if (color) scheme[key] = color;
    else invalid.push(key);
  }
  if (invalid.length) {
    reader.warn(`schemes.${name}: missing or invalid ${invalid.join(', ')}; the scheme was removed.`);
    return null;
  }

  // Same fallbacks as Windows Terminal.
  scheme.cursorColor = normalizeColor(input.cursorColor) ?? '#ffffff';
  scheme.selectionBackground = normalizeColor(input.selectionBackground) ?? '#ffffff';
  return scheme as ColorScheme;
}

/** Canonical chord form: `ctrl+alt+shift+meta+<key>`, lowercase. */
export function normalizeChord(keys: string): string | undefined {
  const raw = keys.trim().toLowerCase();
  if (!raw) return undefined;
  // A trailing `++` means the plus key (`ctrl++`).
  const parts = raw.replace(/\+\+$/, '+plus').split('+').map((part) => part.trim());
  if (parts.some((part) => !part)) return undefined;

  const modifiers = new Set<string>();
  const others: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) modifiers.add(modifier);
    else others.push(part);
  }
  if (others.length !== 1) return undefined;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), others[0]].join('+');
}

function sanitizeKeybinding(input: unknown, index: number, reader: Reader): KeybindingEntry | null {
  const label = `keybindings[${index}]`;
  if (!isObj(input)) {
    reader.warn(`${label}: expected { keys, command }; it was removed.`);
    return null;
  }

  const keys = typeof input.keys === 'string' ? normalizeChord(input.keys) : undefined;
  if (!keys) {
    reader.warn(`${label}: invalid keys ${describe(input.keys)}; the binding was removed.`);
    return null;
  }

  if (input.command !== null && !isCommandId(input.command)) {
    reader.warn(`${label} (${keys}): unknown command ${describe(input.command)}; the binding was removed.`);
    return null;
  }

  const entry: KeybindingEntry = { keys, command: input.command };
  if (input.args !== undefined) {
    if (isObj(input.args)) {
      const args: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(input.args)) {
        if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) args[key] = value;
        else reader.warn(`${label} (${keys}): argument "${key}" must be a string, number or boolean.`);
      }
      if (Object.keys(args).length) entry.args = args;
    } else {
      reader.warn(`${label} (${keys}): args must be an object.`);
    }
  }
  return entry;
}

function sanitizeSnippet(input: unknown, index: number, usedIds: Set<string>, reader: Reader): Snippet | null {
  const label = `snippets[${index}]`;
  if (!isObj(input)) {
    reader.warn(`${label}: expected a snippet object; it was removed.`);
    return null;
  }

  const name = nonEmptyString(input.name);
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  if (!name || !command) {
    reader.warn(`${label}: a snippet needs a name and a command; it was removed.`);
    return null;
  }

  const rawId = nonEmptyString(input.id);
  const id = uniqueId(rawId ?? (slug(name) || 'snippet'), usedIds);
  if (rawId && id !== rawId) reader.warn(`${label}: duplicate snippet id "${rawId}" was renamed to "${id}".`);
  const run = typeof input.run === 'boolean' ? input.run : false;
  if (input.run !== undefined && typeof input.run !== 'boolean') reader.warn(`snippets.${id}.run: expected true/false.`);
  return { id, name, command, run };
}

function sanitizeList<T>(input: unknown, key: string, fallback: T[], reader: Reader, item: (value: unknown, index: number) => T | null): T[] {
  if (input === undefined) return structuredClone(fallback);
  if (!Array.isArray(input)) {
    reader.warn(`${key}: expected an array, got ${describe(input)}.`);
    return structuredClone(fallback);
  }
  return input.map(item).filter((entry): entry is T => entry !== null);
}

function chooseDefaultProfile(requested: string, profiles: ProfileDefinition[], reader: Reader): string {
  const exact = profiles.find((profile) => profile.id === requested);
  if (exact) return exact.id;

  // Tolerate hand-written references by name, WT guid or different casing.
  const key = requested.trim().toLowerCase().replace(/[{}]/g, '');
  const loose = profiles.find((profile) => profile.id.toLowerCase() === key || profile.name.toLowerCase() === key
    || profile.wtGuid?.toLowerCase().replace(/[{}]/g, '') === key);
  if (loose) return loose.id;

  const visible = profiles.filter((profile) => !profile.hidden);
  const fallback = FALLBACK_PROFILE_IDS.map((id) => visible.find((profile) => profile.id === id)).find(Boolean)
    ?? visible[0] ?? profiles[0];
  reader.warn(`defaultProfile: "${requested}" does not match a profile; using "${fallback.id}".`);
  return fallback.id;
}

function sanitizeTerminal(input: Obj, base: TerminalBehaviorSettings, reader: Reader): TerminalBehaviorSettings {
  const path = 'terminal';
  const bellInput = reader.obj(input, 'bell', path);
  const bell: BellSettings = {
    sound: reader.bool(bellInput, 'sound', base.bell.sound, `${path}.bell`),
    visual: reader.bool(bellInput, 'visual', base.bell.visual, `${path}.bell`),
    taskbar: reader.bool(bellInput, 'taskbar', base.bell.taskbar, `${path}.bell`),
  };
  return {
    scrollback: reader.num(input, 'scrollback', base.scrollback, { ...SETTINGS_LIMITS.scrollback, integer: true }, path),
    cursorStyle: reader.oneOf(input, 'cursorStyle', CURSOR_STYLES, base.cursorStyle, path),
    cursorBlink: reader.bool(input, 'cursorBlink', base.cursorBlink, path),
    copyOnSelect: reader.bool(input, 'copyOnSelect', base.copyOnSelect, path),
    copyFormatting: reader.bool(input, 'copyFormatting', base.copyFormatting, path),
    trimTrailingWhitespace: reader.bool(input, 'trimTrailingWhitespace', base.trimTrailingWhitespace, path),
    rightClick: reader.oneOf(input, 'rightClick', ['copyPaste', 'menu'] as const, base.rightClick, path),
    middleClickPaste: reader.bool(input, 'middleClickPaste', base.middleClickPaste, path),
    wordSeparators: reader.str(input, 'wordSeparators', base.wordSeparators, path, true),
    bell,
    autoSubmitSingleLinePaste: reader.bool(input, 'autoSubmitSingleLinePaste', base.autoSubmitSingleLinePaste, path),
    warnMultilinePaste: reader.bool(input, 'warnMultilinePaste', base.warnMultilinePaste, path),
    warnLargePasteBytes: reader.num(input, 'warnLargePasteBytes', base.warnLargePasteBytes, { ...SETTINGS_LIMITS.warnLargePasteBytes, integer: true }, path),
    linkRequiresCtrl: reader.bool(input, 'linkRequiresCtrl', base.linkRequiresCtrl, path),
    unicodeVersion: reader.oneOf(input, 'unicodeVersion', ['11', 'graphemes'] as const, base.unicodeVersion, path),
    gpuAcceleration: reader.oneOf(input, 'gpuAcceleration', ['auto', 'off'] as const, base.gpuAcceleration, path),
    minimumContrastRatio: reader.num(input, 'minimumContrastRatio', base.minimumContrastRatio, SETTINGS_LIMITS.minimumContrastRatio, path),
    smoothScroll: reader.bool(input, 'smoothScroll', base.smoothScroll, path),
    closeOnExit: reader.oneOf(input, 'closeOnExit', CLOSE_ON_EXIT, base.closeOnExit, path),
  };
}

function sanitizeWindow(input: Obj, base: WindowBehaviorSettings, reader: Reader): WindowBehaviorSettings {
  const path = 'window';
  let summonHotkey = base.summonHotkey;
  if (input.summonHotkey === null) summonHotkey = null;
  else if (input.summonHotkey !== undefined) summonHotkey = reader.str(input, 'summonHotkey', base.summonHotkey ?? '', path) || null;
  return {
    newTabDirectory: reader.oneOf(input, 'newTabDirectory', ['inherit', 'profile'] as const, base.newTabDirectory, path),
    confirmCloseRunning: reader.bool(input, 'confirmCloseRunning', base.confirmCloseRunning, path),
    paneHeaders: reader.oneOf(input, 'paneHeaders', ['auto', 'always', 'never'] as const, base.paneHeaders, path),
    restoreSession: reader.bool(input, 'restoreSession', base.restoreSession, path),
    restoreBuffers: reader.bool(input, 'restoreBuffers', base.restoreBuffers, path),
    keepRunningInTray: reader.bool(input, 'keepRunningInTray', base.keepRunningInTray, path),
    launchOnLogin: reader.bool(input, 'launchOnLogin', base.launchOnLogin, path),
    summonHotkey,
  };
}

function sanitizeQuake(input: Obj, base: QuakeSettings, reader: Reader): QuakeSettings {
  return {
    enabled: reader.bool(input, 'enabled', base.enabled, 'quake'),
    hotkey: reader.str(input, 'hotkey', base.hotkey, 'quake'),
    heightPercent: reader.num(input, 'heightPercent', base.heightPercent, SETTINGS_LIMITS.quakeHeightPercent, 'quake'),
  };
}

function sanitizeNotifications(input: Obj, base: NotificationSettings, reader: Reader): NotificationSettings {
  return {
    enabled: reader.bool(input, 'enabled', base.enabled, 'notifications'),
    longCommandSeconds: reader.num(input, 'longCommandSeconds', base.longCommandSeconds, SETTINGS_LIMITS.longCommandSeconds, 'notifications'),
    onlyWhenUnfocused: reader.bool(input, 'onlyWhenUnfocused', base.onlyWhenUnfocused, 'notifications'),
  };
}

function sanitizeInto(input: unknown, base: LookoutSettings, reader: Reader): LookoutSettings {
  if (input !== undefined && input !== null && !isObj(input)) reader.warn(`settings: expected an object, got ${describe(input)}; using defaults.`);
  const root = isObj(input) ? input : {};

  const profileIds = new Set<string>();
  let profiles = sanitizeList(root.profiles, 'profiles', base.profiles, reader, (value, index) => sanitizeProfile(value, index, profileIds, reader));
  if (!profiles.length) {
    if (Array.isArray(root.profiles)) reader.warn('profiles: no usable profiles; the built-in fallback profiles were restored.');
    profiles = base.profiles.length ? structuredClone(base.profiles) : createFallbackProfiles();
  }

  const schemesByName = new Map<string, ColorScheme>();
  for (const scheme of sanitizeList(root.schemes, 'schemes', base.schemes, reader, (value, index) => sanitizeScheme(value, index, reader))) {
    const key = scheme.name.toLowerCase();
    if (schemesByName.has(key)) reader.warn(`schemes: "${scheme.name}" is defined more than once; the last definition is used.`);
    schemesByName.delete(key);
    schemesByName.set(key, scheme);
  }
  const schemes = [...schemesByName.values()];

  let colorScheme = reader.str(root, 'colorScheme', base.colorScheme, 'settings');
  if (!findScheme(colorScheme, schemes)) {
    const fallback = findScheme(base.colorScheme, schemes) ? base.colorScheme : DEFAULT_COLOR_SCHEME;
    reader.warn(`colorScheme: "${colorScheme}" is not a known color scheme; using "${fallback}".`);
    colorScheme = fallback;
  }

  // Later bindings for the same chord win.
  const keybindings = new Map<string, KeybindingEntry>();
  for (const entry of sanitizeList(root.keybindings, 'keybindings', base.keybindings, reader, (value, index) => sanitizeKeybinding(value, index, reader))) {
    keybindings.delete(entry.keys);
    keybindings.set(entry.keys, entry);
  }

  const snippetIds = new Set<string>();
  const snippets = sanitizeList(root.snippets, 'snippets', base.snippets, reader, (value, index) => sanitizeSnippet(value, index, snippetIds, reader));
  const requestedDefault = reader.str(root, 'defaultProfile', base.defaultProfile, 'settings');

  return {
    version: 2,
    defaultProfile: chooseDefaultProfile(requestedDefault, profiles, reader),
    profiles,
    font: sanitizeFont(root.font, base.font, 'font', reader),
    colorScheme,
    schemes,
    appTheme: reader.oneOf(root, 'appTheme', ['system', 'dark', 'light'] as const, base.appTheme, 'settings'),
    darkTheme: reader.oneOf(root, 'darkTheme', DARK_THEMES, base.darkTheme, 'settings'),
    keybindings: [...keybindings.values()],
    snippets,
    terminal: sanitizeTerminal(reader.obj(root, 'terminal', 'settings'), base.terminal, reader),
    window: sanitizeWindow(reader.obj(root, 'window', 'settings'), base.window, reader),
    quake: sanitizeQuake(reader.obj(root, 'quake', 'settings'), base.quake, reader),
    notifications: sanitizeNotifications(reader.obj(root, 'notifications', 'settings'), base.notifications, reader),
    gitStatus: reader.bool(root, 'gitStatus', base.gitStatus, 'settings'),
  };
}

/**
 * Deep-validates untrusted settings (a parsed settings.json, a first-run result or an
 * edited draft). Missing fields come from `base`; invalid values fall back to `base`
 * or are clamped, and every correction is reported in `warnings`. Never throws.
 */
export function sanitizeSettings(input: unknown, base: LookoutSettings = createDefaultSettings()): { settings: LookoutSettings; warnings: string[] } {
  const warnings: string[] = [];
  try {
    return { settings: sanitizeInto(input, base, new Reader(warnings)), warnings };
  } catch (error) {
    // Defensive: e.g. a getter that throws or a cyclic structure in a hand-built object.
    warnings.push(`settings could not be read (${error instanceof Error ? error.message : String(error)}); using defaults.`);
    try {
      return { settings: sanitizeInto(undefined, base, new Reader([])), warnings };
    } catch {
      return { settings: createDefaultSettings(), warnings };
    }
  }
}
