import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { detectShellKindFromCommandLine, getEnv } from '../../src/shared/commandline';
import { COMMANDS } from '../../src/shared/commands';
import type { CommandId } from '../../src/shared/commands';
import type { ColorScheme, FontSettings, KeybindingEntry, ProfileDefinition } from '../../src/shared/settings';
import { findScheme, parseWtSchemes } from '../../src/shared/color-schemes';
import { detectProfiles } from './detect';
import { parseJsonc } from './jsonc';

export interface WtImportedTab {
  profileId?: string;
  title?: string;
  startingDirectory?: string;
  commandline?: string;
  panes?: Array<{ split: 'right' | 'down'; profileId?: string; startingDirectory?: string; commandline?: string }>;
}

export interface WtImportResult {
  sourcePath: string;
  profiles: ProfileDefinition[];
  defaultProfileId?: string;
  schemes: ColorScheme[];
  font?: Partial<FontSettings>;
  keybindings: KeybindingEntry[];
  layouts: WtImportedTab[];
  warnings: string[];
}

type JsonObject = Record<string, unknown>;
type MappedAction = { command: CommandId | null; args?: KeybindingEntry['args'] };

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function identity(value: string): string {
  return value.replace(/[{}]/g, '').toLowerCase();
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
}

function parseFont(value: JsonObject): Partial<FontSettings> | undefined {
  const font = object(value.font);
  const result: Partial<FontSettings> = {};
  const face = string(font.face) ?? string(value.fontFace);
  const size = font.size ?? value.fontSize;
  if (face) result.face = face;
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) result.size = size;
  if (typeof font.lineHeight === 'number' && Number.isFinite(font.lineHeight) && font.lineHeight > 0) result.lineHeight = font.lineHeight;
  if (typeof font.letterSpacing === 'number' && Number.isFinite(font.letterSpacing)) result.letterSpacing = font.letterSpacing;
  const weights: Record<string, FontSettings['weight']> = {
    thin: '100', 'extra-light': '200', light: '300', 'semi-light': '300', normal: 'normal',
    medium: '500', 'semi-bold': '600', bold: 'bold', 'extra-bold': '800', black: '900', 'extra-black': '900',
  };
  const weight = font.weight ?? value.fontWeight;
  if (weight !== undefined) {
    const key = String(weight);
    const mapped = Object.hasOwn(weights, key) ? weights[key] : (/^[1-9]00$/.test(key) ? key as FontSettings['weight'] : undefined);
    if (mapped) result.weight = mapped;
  }
  return Object.keys(result).length ? result : undefined;
}

function overrides(defaults: JsonObject, entry: JsonObject): JsonObject {
  const merged = { ...defaults, ...entry };
  // Font properties are independently inherited by WT. Legacy font fields
  // must be layered separately so a per-profile fontFace can beat a default font.face.
  merged.font = { ...parseFont(defaults), ...parseFont(entry) };
  return merged;
}

function applyOverrides(profile: ProfileDefinition, value: JsonObject): ProfileDefinition {
  const result = { ...profile };
  for (const key of ['name', 'startingDirectory', 'tabColor'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  for (const key of ['hidden', 'elevate', 'cursorBlink'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  const scheme = typeof value.colorScheme === 'string' ? value.colorScheme
    : string(object(value.colorScheme).dark) ?? string(object(value.colorScheme).light);
  if (scheme) result.colorScheme = scheme;
  const font = parseFont(value);
  if (font) result.font = { ...profile.font, ...font };
  const icon = string(value.icon);
  // Lookout currently accepts text icons only, not file paths or ms-appx URIs.
  if (icon && !/[\\/:.%\p{Cc}]/u.test(icon) && [...icon].length <= 12
    && ([...icon].length <= 2 || /[\p{Extended_Pictographic}\p{Co}]/u.test(icon))) result.icon = icon;
  const cursors: Record<string, ProfileDefinition['cursorStyle']> = {
    bar: 'bar', vintage: 'block', filledBox: 'block', emptyBox: 'block',
    underscore: 'underline', doubleUnderscore: 'underline',
  };
  const cursor = string(value.cursorShape);
  if (cursor && Object.hasOwn(cursors, cursor)) result.cursorStyle = cursors[cursor];
  const close = value.closeOnExit;
  if (close === 'always' || close === 'never' || close === 'graceful') result.closeOnExit = close;
  else if (close === true || close === 'automatic') result.closeOnExit = 'graceful';
  else if (close === false) result.closeOnExit = 'never';
  if (value.environment && typeof value.environment === 'object') {
    result.env = Object.fromEntries(Object.entries(object(value.environment)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
  return result;
}

function dynamicMatch(entry: JsonObject, detected: ProfileDefinition[]): ProfileDefinition | undefined {
  const source = entry.source;
  const name = string(entry.name)?.toLowerCase();
  if (source === 'Windows.Terminal.PowershellCore') return detected.find((item) => item.id === 'pwsh');
  if (source === 'Microsoft.WSL' || source === 'Windows.Terminal.Wsl') {
    return detected.find((item) => (item.shellKind === 'wsl' || item.id.startsWith('wsl-')) && item.name.toLowerCase() === name);
  }
  if (source === 'Windows.Terminal.VisualStudio') return detected.find((item) => item.name.toLowerCase() === name);
  return undefined;
}

function chord(value: string): string | undefined {
  const aliases: Record<string, string> = {
    control: 'ctrl', win: 'meta', windows: 'meta', super: 'meta', cmd: 'meta',
    pgup: 'pageup', pgdn: 'pagedown', prior: 'pageup', next: 'pagedown', esc: 'escape',
    return: 'enter', spacebar: 'space', ' ': 'space', del: 'delete', ins: 'insert',
    back: 'backspace', oem_plus: 'plus', oem_minus: 'minus', oem_3: '`',
    backtick: '`', grave: '`', 'sc(41)': '`', 'vk(192)': '`', 'vk(0xc0)': '`',
    'vk(187)': 'plus', 'vk(189)': 'minus', '+': 'plus', '-': 'minus',
    numpad_plus: 'plus', numpad_minus: 'minus',
  };
  const parts = value.trim().toLowerCase().replace(/\+\+$/, '+plus').split('+').map((part) => part.trim());
  if (value === '+') return 'plus';
  const normalized = parts.map((part) => aliases[part] ?? part);
  const modifierOrder = ['ctrl', 'alt', 'shift', 'meta'];
  const keys = normalized.filter((part) => !modifierOrder.includes(part));
  if (keys.length !== 1) return undefined;
  const key = keys[0].replace(/^numpad_([0-9])$/, '$1');
  if (!/^(?:[^\s+]|f(?:[1-9]|1\d|2[0-4])|pageup|pagedown|escape|enter|space|tab|backspace|delete|insert|home|end|left|right|up|down|plus|minus|pause|printscreen|scrolllock|capslock|numlock|menu)$/.test(key)) return undefined;
  return [...modifierOrder.filter((part) => normalized.includes(part)), key].join('+');
}

const SIMPLE_ACTIONS: Record<string, CommandId> = {
  copy: 'copy', paste: 'paste', find: 'find', selectAll: 'selectAll', newTab: 'newTab', newWindow: 'newWindow',
  closePane: 'closePane', closeTab: 'closeTab', nextTab: 'nextTab', prevTab: 'prevTab', duplicateTab: 'duplicateTab',
  togglePaneZoom: 'togglePaneZoom', commandPalette: 'commandPalette', openSettings: 'openSettings',
  toggleFullscreen: 'toggleFullscreen', resetFontSize: 'fontSizeReset', scrollUp: 'scrollUp', scrollDown: 'scrollDown',
  scrollUpPage: 'scrollPageUp', scrollDownPage: 'scrollPageDown', scrollToTop: 'scrollToTop', scrollToBottom: 'scrollToBottom',
  quakeMode: 'toggleQuake', renameTab: 'renameTab', openTabRenamer: 'renameTab', clearBuffer: 'clearBuffer',
  restoreLastClosed: 'reopenClosedTab', closeOtherTabs: 'closeOtherTabs', toggleBroadcastInput: 'toggleBroadcast', quit: 'quit',
};

// WT >= 1.21 keeps builtin actions and user bindings in separate arrays.
const BUILTIN_ACTIONS: Record<string, unknown> = {
  CopyToClipboard: 'copy', PasteFromClipboard: 'paste', FindText: 'find', SelectAll: 'selectAll',
  OpenNewTab: 'newTab', OpenNewWindow: 'newWindow', OpenNewTabDropdown: 'openNewTabDropdown',
  ClosePane: 'closePane', CloseTab: 'closeTab', NextTab: 'nextTab', PrevTab: 'prevTab', DuplicateTab: 'duplicateTab',
  TogglePaneZoom: 'togglePaneZoom', ToggleCommandPalette: 'commandPalette', OpenSettingsUI: 'openSettings',
  OpenSettingsFile: { action: 'openSettings', target: 'settingsFile' }, ToggleFullscreen: 'toggleFullscreen',
  IncreaseFontSize: { action: 'adjustFontSize', delta: 1 }, DecreaseFontSize: { action: 'adjustFontSize', delta: -1 },
  ResetFontSize: 'resetFontSize', ScrollUp: 'scrollUp', ScrollDown: 'scrollDown', ScrollUpPage: 'scrollUpPage',
  ScrollDownPage: 'scrollDownPage', ScrollToTop: 'scrollToTop', ScrollToBottom: 'scrollToBottom',
  QuakeMode: 'quakeMode', RenameTab: 'renameTab', OpenTabRenamer: 'openTabRenamer',
  RestoreLastClosed: 'restoreLastClosed', ClearBuffer: 'clearBuffer', CloseOtherTabs: 'closeOtherTabs',
  ToggleBroadcastInput: 'toggleBroadcastInput', Quit: 'quit', OpenCWD: 'openCWD',
  SwitchToLastTab: { action: 'switchToTab', index: -1 },
  FindNextMatch: { action: 'findMatch', direction: 'next' }, FindPrevMatch: { action: 'findMatch', direction: 'prev' },
};

function builtin(id: string): unknown {
  if (!id.startsWith('Terminal.')) return undefined;
  const name = id.slice(9);
  if (Object.hasOwn(BUILTIN_ACTIONS, name)) return BUILTIN_ACTIONS[name];
  const indexed = /^(OpenNewTabProfile|SwitchToTab)(\d+)$/.exec(name);
  if (indexed) return { action: indexed[1] === 'SwitchToTab' ? 'switchToTab' : 'newTab', index: Number(indexed[2]) };
  const directional = /^(DuplicatePane|SplitPane|MoveFocus|ResizePane)(Auto|Right|Down|Left|Up|Previous|NextInOrder|PreviousInOrder)$/.exec(name);
  if (directional) {
    const direction = directional[2][0].toLowerCase() + directional[2].slice(1);
    if (directional[1] === 'DuplicatePane' || directional[1] === 'SplitPane') {
      return { action: 'splitPane', split: direction, ...(directional[1] === 'DuplicatePane' ? { splitMode: 'duplicate' } : {}) };
    }
    return { action: directional[1] === 'MoveFocus' ? 'moveFocus' : 'resizePane', direction };
  }
  return undefined;
}

function importKeybindings(
  settings: JsonObject,
  resolveProfile: (reference: unknown) => string | undefined,
  resolveIndex: (index: number) => number | undefined,
  warnings: string[],
): KeybindingEntry[] {
  const actions = Array.isArray(settings.actions) ? settings.actions : [];
  const bindings = Array.isArray(settings.keybindings) ? settings.keybindings : [];
  const definitions = new Map<string, unknown>();
  function collect(values: unknown[]): void {
    for (const value of values) {
      const entry = object(value);
      if (typeof entry.id === 'string' && Object.hasOwn(entry, 'command')) definitions.set(entry.id, entry.command);
      if (Array.isArray(entry.commands)) collect(entry.commands);
    }
  }
  collect(actions);
  function dereference(command: unknown, seen = new Set<string>()): unknown {
    if (typeof command !== 'string' || seen.has(command)) return command;
    seen.add(command);
    const resolved = definitions.has(command) ? definitions.get(command) : builtin(command);
    return resolved === undefined ? command : dereference(resolved, seen);
  }
  function map(command: unknown): MappedAction | undefined {
    command = dereference(command);
    if (command === null || command === 'unbound') return { command: null };
    const value = object(command);
    const action = typeof command === 'string' ? command : string(value.action);
    if (!action) return undefined;
    if (action === 'newTab') {
      if (typeof value.index === 'number' && Number.isInteger(value.index)) {
        const index = resolveIndex(value.index);
        return index === undefined ? undefined : { command: 'newTabProfileIndex', args: { index } };
      }
      if (value.profile !== undefined) {
        const profile = resolveProfile(value.profile);
        return profile ? { command: 'newTab', args: { profile } } : undefined;
      }
    }
    if (action === 'switchToTab' && typeof value.index === 'number' && Number.isInteger(value.index)) {
      return { command: 'switchToTab', args: { index: value.index === 4294967295 ? -1 : value.index } };
    }
    if (action === 'splitPane') {
      if (value.splitMode === 'duplicate') return { command: 'splitAuto' };
      const split = value.split ?? 'auto';
      const command = split === 'right' || split === 'vertical' ? 'splitRight'
        : split === 'down' || split === 'horizontal' ? 'splitDown' : split === 'auto' ? 'splitAuto' : undefined;
      if (!command || value.type === 'snippets') return undefined;
      if (value.profile !== undefined) {
        const profile = resolveProfile(value.profile);
        if (!profile) return undefined;
        return { command, args: { profile } };
      }
      return { command };
    }
    if (action === 'moveFocus') {
      if (value.direction === 'nextInOrder') return { command: 'focusNextPane' };
      if (value.direction === 'previous' || value.direction === 'previousInOrder') return { command: 'focusPrevPane' };
    }
    if (action === 'moveFocus' || action === 'resizePane') {
      if (!['left', 'right', 'up', 'down'].includes(String(value.direction))) return undefined;
      return { command: action === 'moveFocus' ? 'focusPane' : 'resizePane', args: { direction: String(value.direction) } };
    }
    if (action === 'adjustFontSize' && typeof value.delta === 'number' && Number.isFinite(value.delta) && value.delta !== 0) {
      return { command: value.delta > 0 ? 'fontSizeIncrease' : 'fontSizeDecrease' };
    }
    if (action === 'scrollToMark') {
      return value.direction === 'previous' ? { command: 'prevCommand' } : value.direction === 'next' ? { command: 'nextCommand' } : undefined;
    }
    if (action === 'sendInput' && typeof value.input === 'string') return { command: 'sendInput', args: { input: value.input } };
    if (action === 'openSettings' && value.target === 'settingsFile') return { command: 'openSettingsJson' };
    if (action === 'openNewTabDropdown') return { command: 'newTabMenu' };
    if (action === 'openCWD') return { command: 'openInExplorer' };
    if (action === 'findMatch') return value.direction === 'next' ? { command: 'findNext' } : value.direction === 'prev' ? { command: 'findPrev' } : undefined;
    const mapped = SIMPLE_ACTIONS[action];
    return mapped && Object.hasOwn(COMMANDS, mapped) ? { command: mapped } : undefined;
  }

  const result = new Map<string, KeybindingEntry>();
  for (const entry of [...actions, ...bindings].map(object)) {
    if (!Object.hasOwn(entry, 'keys') || entry.keys === null) continue;
    const keys = Array.isArray(entry.keys) ? entry.keys : [entry.keys];
    const mapped = map(Object.hasOwn(entry, 'command') ? entry.command : entry.id);
    if (!mapped) {
      warnings.push(`Skipped an unsupported Windows Terminal keybinding (${string(entry.id) ?? string(object(entry.command).action) ?? string(entry.command) ?? 'unknown action'}).`);
      continue;
    }
    for (const key of keys) {
      const converted = typeof key === 'string' ? chord(key) : undefined;
      if (converted) result.set(converted, { keys: converted, ...mapped });
      else warnings.push('Skipped an unsupported Windows Terminal key chord.');
    }
  }
  return [...result.values()];
}

function importLayouts(state: JsonObject, resolveProfile: (reference: unknown) => string | undefined, warnings: string[]): WtImportedTab[] {
  if (!Array.isArray(state.persistedWindowLayouts)) return [];
  const tabs: WtImportedTab[] = [];
  for (const window of state.persistedWindowLayouts) {
    const windowTabs: WtImportedTab[] = [];
    let current: WtImportedTab | undefined;
    const terminal = (value: JsonObject): Omit<WtImportedTab, 'panes'> => {
      const result: Omit<WtImportedTab, 'panes'> = {};
      const profile = resolveProfile(value.profile ?? value.profileId ?? value.index);
      if (profile) result.profileId = profile;
      else if (value.profile !== undefined || value.index !== undefined) warnings.push('A saved tab or pane refers to an unavailable Windows Terminal profile.');
      if (typeof value.commandline === 'string') result.commandline = value.commandline;
      if (typeof value.startingDirectory === 'string') result.startingDirectory = value.startingDirectory;
      if (typeof value.tabTitle === 'string') result.title = value.tabTitle;
      return result;
    };
    function visit(actions: unknown[]): void {
      for (const raw of actions) {
        const value = object(raw);
        const command = Object.hasOwn(value, 'command') ? value.command : raw;
        const args = typeof command === 'string' ? value : object(command);
        const action = typeof command === 'string' ? command : string(args.action);
        if (action === 'multipleActions' && Array.isArray(args.actions)) visit(args.actions);
        else if (action === 'newTab') {
          current = terminal(args);
          windowTabs.push(current);
        } else if (action === 'splitPane' && current) {
          const split = args.split === 'down' || args.split === 'horizontal' ? 'down' : 'right';
          if (args.split === 'left' || args.split === 'up') warnings.push('A saved pane split was normalized to right/down.');
          const { title: _title, ...pane } = terminal(args);
          current.panes ??= [];
          current.panes.push({ split, ...pane });
        } else if (action === 'renameTab' && current && typeof args.title === 'string') current.title = args.title;
        else if (action === 'switchToTab' && typeof args.index === 'number') current = windowTabs[args.index];
        else if (action === 'moveFocus' || action === 'focusPane') warnings.push('Saved pane focus and nesting are flattened in imported layouts.');
      }
    }
    const layout = object(window).tabLayout;
    if (Array.isArray(layout)) visit(layout);
    tabs.push(...windowTabs);
  }
  return tabs;
}

/** Import the first installed WT settings file. This function never writes WT settings or state. */
export async function importWindowsTerminal(
  options: { env?: NodeJS.ProcessEnv; detected?: ProfileDefinition[] } = {},
): Promise<WtImportResult | null> {
  const env = options.env ?? process.env;
  const local = getEnv(env, 'LOCALAPPDATA');
  if (!local) return null;
  const candidates = [
    join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  let sourcePath: string | undefined;
  let text = '';
  const warnings: string[] = [];
  for (const path of candidates) {
    try {
      text = await readFile(path, 'utf8');
      sourcePath = path;
      break;
    } catch (error) {
      if (object(error).code !== 'ENOENT') warnings.push(`Could not read Windows Terminal settings at ${path}.`);
    }
  }
  if (!sourcePath) return null;
  const result: WtImportResult = { sourcePath, profiles: [], schemes: [], keybindings: [], layouts: [], warnings };
  let settings: JsonObject;
  try {
    const parsed = parseJsonc(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a settings object');
    settings = object(parsed);
  } catch {
    warnings.push('Windows Terminal settings could not be parsed as JSONC.');
    return result;
  }

  const profileSettings = object(settings.profiles);
  const defaults = object(profileSettings.defaults);
  const entries: unknown[] = Array.isArray(settings.profiles) ? settings.profiles
    : Array.isArray(profileSettings.list) ? profileSettings.list : [];
  const detected = options.detected ?? (entries.some((entry) => !!object(entry).source) ? await detectProfiles({ env }) : []);
  // Reserve dynamic ids up front, including those that appear after static
  // entries; unrelated detections need not add suffixes to imported names.
  const used = new Set(entries.map((entry) => dynamicMatch(object(entry), detected)?.id).filter((id): id is string => !!id));
  const references = new Map<string, string>();
  const importedByEntry = new Map<unknown, ProfileDefinition>();
  for (const raw of entries) {
    const entry = object(raw);
    const name = string(entry.name) ?? 'Imported profile';
    const effective = overrides(defaults, entry);
    let base: ProfileDefinition;
    if (entry.source) {
      const match = dynamicMatch(entry, detected);
      if (!match) {
        warnings.push(`Skipped "${name}": ${String(entry.source)} is unsupported or its shell is not installed.`);
        continue;
      }
      base = { ...match };
    } else {
      const commandline = string(effective.commandline);
      if (!commandline?.trim()) {
        warnings.push(`Skipped "${name}": no command line is available.`);
        continue;
      }
      const stem = slug(name);
      let id = stem;
      for (let index = 2; used.has(id); index += 1) id = `${stem}-${index}`;
      used.add(id);
      base = { id, name, commandline, shellKind: detectShellKindFromCommandLine(commandline) };
    }
    const imported = applyOverrides(base, effective);
    imported.source = 'windows-terminal';
    imported.wtGuid = string(entry.guid);
    importedByEntry.set(raw, imported);
    const guid = string(entry.guid);
    if (guid) references.set(identity(guid), imported.id);
    references.set(identity(name), imported.id);
    references.set(identity(imported.id), imported.id);
    const duplicate = result.profiles.findIndex((profile) => profile.id === imported.id);
    if (duplicate >= 0) {
      result.profiles[duplicate] = imported;
      warnings.push(`Multiple Windows Terminal profiles map to "${imported.id}"; the last overrides were used.`);
    } else result.profiles.push(imported);
  }

  const visibleEntries = entries.filter((entry) => overrides(defaults, object(entry)).hidden !== true);
  const resolveProfile = (reference: unknown): string | undefined => {
    if (typeof reference === 'number') return importedByEntry.get(visibleEntries[reference])?.id;
    return typeof reference === 'string' ? references.get(identity(reference)) : undefined;
  };
  const resolveIndex = (index: number): number | undefined => {
    const id = resolveProfile(index);
    const mapped = result.profiles.filter((profile) => !profile.hidden).findIndex((profile) => profile.id === id);
    return mapped >= 0 ? mapped : undefined;
  };
  const defaultProfileId = resolveProfile(settings.defaultProfile);
  if (defaultProfileId) result.defaultProfileId = defaultProfileId;
  else if (settings.defaultProfile !== undefined) warnings.push('The Windows Terminal default profile could not be imported.');
  result.font = parseFont(defaults);
  result.schemes = parseWtSchemes(settings);
  for (const profile of result.profiles) {
    if (profile.colorScheme && !findScheme(profile.colorScheme, result.schemes)) warnings.push(`Color scheme "${profile.colorScheme}" was not found.`);
  }
  result.keybindings = importKeybindings(settings, resolveProfile, resolveIndex, warnings);
  try {
    const statePath = join(dirname(sourcePath), 'state.json');
    result.layouts = importLayouts(object(parseJsonc(await readFile(statePath, 'utf8'))), resolveProfile, warnings);
  } catch (error) {
    if (object(error).code !== 'ENOENT') warnings.push('Windows Terminal saved window layouts could not be read.');
  }
  result.warnings = [...new Set(warnings)];
  return result;
}
