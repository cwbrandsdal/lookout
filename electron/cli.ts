import { statSync } from 'node:fs';
import path from 'node:path';
import { joinCommandLine } from '../src/shared/commandline';
import type { WindowAction } from '../src/shared/ipc';

export interface CliNewTab {
  type: 'new-tab';
  profile?: string;
  startingDirectory?: string;
  title?: string;
  tabColor?: string;
  commandline?: string;
}

export interface CliSplitPane {
  type: 'split-pane';
  direction: 'right' | 'down' | 'auto';
  size?: number;
  profile?: string;
  startingDirectory?: string;
  title?: string;
  commandline?: string;
}

export interface CliFocusTab { type: 'focus-tab'; index: number }
export interface CliOpenWorkspace { type: 'open-workspace'; name: string }
export interface CliSimple { type: 'settings' | 'quake' | 'admin-window' }
export type CliAction = CliNewTab | CliSplitPane | CliFocusTab | CliOpenWorkspace | CliSimple;
export interface CliRequest {
  window: 'last' | 'new' | string;
  actions: CliAction[];
  elevated: boolean;
  help: boolean;
  version: boolean;
  errors: string[];
}

const COMMANDS = new Set(['new-tab', 'nt', 'split-pane', 'sp', 'focus-tab', 'ft', 'open', 'settings', 'quake', 'admin']);
const VALUE_OPTIONS = new Set(['-w', '--window', '-p', '--profile', '-d', '--startingDirectory', '--title', '--tabColor', '-s', '--size', '-t', '--target']);

// Use Windows path semantics even when parsing a Windows request in a test on another OS.
function resolveDirectory(cwd: string, value: string): string {
  const paths = path.win32.isAbsolute(cwd) ? path.win32 : path;
  return paths.resolve(cwd, value);
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function segments(argv: string[]): string[][] {
  const result: string[][] = [[]];
  for (const arg of argv) {
    // A separator must be standalone or at the end; embedded shell scripts stay intact.
    const trailing = arg.match(/;+$/)?.[0].length ?? 0;
    if (!trailing) {
      result[result.length - 1].push(arg);
      continue;
    }
    const value = arg.slice(0, -trailing);
    if (value) result[result.length - 1].push(value);
    for (let index = 0; index < trailing; index += 1) result.push([]);
  }
  return result;
}

/**
 * Arguments for the elevated relaunch that carries a request into the
 * administrator window: the first new tab or workspace in `actions`.
 */
export function adminLaunchArgs(actions: readonly WindowAction[]): string[] {
  const first = actions.find((action) => action.type === 'new-tab' || action.type === 'open-workspace');
  if (first?.type === 'open-workspace') {
    return ['open', first.nameOrId];
  }
  if (first?.type !== 'new-tab') {
    return [];
  }
  const args = ['new-tab'];
  if (first.profileId) args.push('-p', first.profileId);
  if (first.cwd) args.push('-d', first.cwd);
  return args;
}

/** Parse application arguments (after stripElectronArgs). No Electron or process state is used. */
export function parseCliArgs(argv: string[], cwd: string): CliRequest {
  const request: CliRequest = { window: 'last', actions: [], elevated: false, help: false, version: false, errors: [] };
  let hadActionInput = false;

  for (const segment of segments(argv)) {
    let index = 0;
    function takeValue(option: string): string | undefined {
      const value = segment[index + 1];
      if (value === undefined || value === '--' || /^--?[A-Za-z]/.test(value)) {
        request.errors.push(`Missing value for ${option}.`);
        index += 1;
        return undefined;
      }
      index += 2;
      return value;
    }
    function globalOption(): boolean {
      const option = segment[index];
      if (option === '-w' || option === '--window') {
        const value = takeValue(option);
        if (value !== undefined) {
          if (!value.trim()) request.errors.push('Window must not be empty.');
          else request.window = value === '0' ? 'last' : value;
        }
        return true;
      }
      const flag = { '--elevated': 'elevated', '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' } as const;
      const key = flag[option as keyof typeof flag];
      if (!key) return false;
      request[key] = true;
      index += 1;
      return true;
    }

    while (index < segment.length && globalOption()) { /* Global prefix. */ }
    if (index === segment.length) continue;
    hadActionInput = true;
    const command = segment[index];
    const explicit = COMMANDS.has(command);
    if (explicit) index += 1;

    if (command === 'settings' || command === 'quake' || command === 'admin') {
      request.actions.push({ type: command === 'admin' ? 'admin-window' : command });
      while (index < segment.length) {
        if (!globalOption()) request.errors.push(`Unexpected argument for ${command}: ${segment[index++]}`);
      }
      continue;
    }
    if (command === 'open') {
      const name = segment[index++];
      if (name === undefined || !name.trim() || name.startsWith('-')) request.errors.push('open requires a workspace name.');
      else request.actions.push({ type: 'open-workspace', name });
      while (index < segment.length) {
        if (!globalOption()) request.errors.push(`Unexpected argument for open: ${segment[index++]}`);
      }
      continue;
    }
    if (command === 'focus-tab' || command === 'ft') {
      let target: number | undefined;
      while (index < segment.length) {
        if (globalOption()) continue;
        const option = segment[index];
        if (option !== '-t' && option !== '--target') {
          request.errors.push(`Unexpected argument for focus-tab: ${segment[index++]}`);
          continue;
        }
        const value = takeValue(option);
        if (value !== undefined) {
          const parsed = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) request.errors.push('Tab target must be a non-negative integer.');
          else target = parsed;
        }
      }
      if (target === undefined) request.errors.push('focus-tab requires -t/--target <index>.');
      else request.actions.push({ type: 'focus-tab', index: target });
      continue;
    }

    const action: CliNewTab | CliSplitPane = command === 'split-pane' || command === 'sp'
      ? { type: 'split-pane', direction: 'auto' }
      : { type: 'new-tab' };
    if (!explicit && segment.length - index === 1 && (command === '.' || isDirectory(resolveDirectory(cwd, command)))) {
      action.startingDirectory = resolveDirectory(cwd, command);
      index += 1;
    }
    let directionChosen = false;
    while (index < segment.length) {
      if (globalOption()) continue;
      const option = segment[index];
      if (option === '--') {
        index += 1;
        break;
      }
      if (option === '-p' || option === '--profile' || option === '-d' || option === '--startingDirectory'
        || option === '--title' || (option === '--tabColor' && action.type === 'new-tab')) {
        const value = takeValue(option);
        if (value === undefined) continue;
        if (option === '-p' || option === '--profile') action.profile = value;
        else if (option === '-d' || option === '--startingDirectory') action.startingDirectory = resolveDirectory(cwd, value);
        else if (option === '--title') action.title = value;
        else if (action.type === 'new-tab') action.tabColor = value;
        continue;
      }
      if (action.type === 'split-pane' && (option === '-H' || option === '--horizontal' || option === '-V' || option === '--vertical')) {
        const direction = option === '-H' || option === '--horizontal' ? 'down' : 'right';
        if (directionChosen && direction !== action.direction) request.errors.push('Choose either horizontal or vertical splitting.');
        action.direction = direction;
        directionChosen = true;
        index += 1;
        continue;
      }
      if (action.type === 'split-pane' && (option === '-s' || option === '--size')) {
        const value = takeValue(option);
        if (value !== undefined) {
          const size = Number(value);
          if (!value.trim() || !Number.isFinite(size) || size < 0 || size > 1) request.errors.push('Split size must be between 0 and 1.');
          else action.size = size;
        }
        continue;
      }
      if (option.startsWith('-')) {
        request.errors.push(`Unknown option: ${option}`);
        index += 1;
        continue;
      }
      break;
    }
    if (index < segment.length) action.commandline = joinCommandLine(segment.slice(index));
    request.actions.push(action);
  }

  if (!hadActionInput && !request.help && !request.version && request.errors.length === 0) {
    request.actions.push({ type: 'new-tab', startingDirectory: resolveDirectory(cwd, '.') });
  }
  return request;
}

const ELECTRON_FLAGS = new Set([
  '--allow-file-access-from-files', '--allow-running-insecure-content', '--no-sandbox', '--disable-sandbox',
  '--disable-gpu', '--disable-gpu-sandbox', '--enable-logging', '--disable-dev-shm-usage', '--no-proxy-server',
]);
const ELECTRON_VALUE_FLAGS = new Set([
  '--original-process-start-time', '--enable-features', '--disable-features', '--remote-debugging-port',
  '--remote-debugging-address', '--inspect', '--inspect-brk', '--inspect-wait', '--inspect-port', '--js-flags', '--log-file', '--v',
  '--user-data-dir', '--lang',
]);

function hasSeparateElectronValue(name: string, next: string | undefined): boolean {
  if (next === undefined || next.startsWith('-')) return false;
  // Inspector switches accept an optional host:port. A following shell name is
  // the user's command, not an inspector value.
  if (name.startsWith('--inspect')) return /^(?:\d+|(?:\[[^\]]+\]|[^\\/\s:]+):\d+)$/.test(next);
  if (name === '--remote-debugging-port' || name === '--original-process-start-time' || name === '--v') return /^\d+$/.test(next);
  return ELECTRON_VALUE_FLAGS.has(name);
}

export function stripElectronArgs(argv: string[], options: { isPackaged: boolean }): string[] {
  const result: string[] = [];
  let appPathPending = !options.isPackaged;
  let valuePending = false;
  let commandline = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commandline || valuePending) {
      result.push(arg);
      valuePending = false;
      continue;
    }
    const name = arg.split('=', 1)[0];
    if (ELECTRON_FLAGS.has(name) || ELECTRON_VALUE_FLAGS.has(name)) {
      if (!arg.includes('=') && hasSeparateElectronValue(name, argv[index + 1])) index += 1;
      continue;
    }
    if (appPathPending && !arg.startsWith('-')) {
      appPathPending = false;
      continue;
    }
    result.push(arg);
    if (VALUE_OPTIONS.has(arg)) valuePending = true;
    else if (arg === '--' || (!arg.startsWith('-') && !COMMANDS.has(arg) && arg !== ';')) commandline = true;
  }
  return result;
}

export const CLI_HELP_TEXT = `Usage: lookout [global options] [command [options]] [; command ...]

Global options:
  -w, --window <id|new|last|0>  Target a window (0 means last; default: last)
  -h, --help                   Show this help
  -v, --version                Show the version
  --elevated                   Internal flag for an elevated relaunch

Commands:
  new-tab, nt [-p profile] [-d directory] [--title text] [--tabColor color] [command...]
  split-pane, sp [-H|--horizontal|-V|--vertical] [-s size] [-p profile] [-d directory] [--title text] [command...]
    -H puts the new pane below; -V puts it to the right; default: auto.
    Size is the new pane fraction, between 0 and 1.
  focus-tab, ft -t|--target <index>
  open <workspace>
  settings
  quake
  admin

Profile and directory also accept --profile and --startingDirectory.
Use -- before a command whose first argument starts with a dash.
No arguments opens a tab in the caller's directory; a directory alone opens there.
In PowerShell, escape a separator with a backtick or quote it: lookout nt ';' sp -H
`;
