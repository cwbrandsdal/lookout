// Pure helpers for the settings UI: env text, ids, profile templates, scheme import.

import { parseItermColors, parseWtSchemes } from '../../shared/color-schemes';
import type { ColorScheme, ProfileDefinition, ProfileSource, ShellKind } from '../../shared/settings';

// ---- Environment variables ----------------------------------------------------

export interface EnvParseResult {
  env: Record<string, string>;
  errors: string[];
}

/** `KEY=VALUE` per line. Blank lines and `#` comments are ignored; later keys win. */
export function parseEnvText(text: string): EnvParseResult {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const equals = line.indexOf('=');
    const key = equals > 0 ? line.slice(0, equals).trim() : '';
    if (!key) {
      errors.push(`Line ${index + 1}: expected KEY=VALUE.`);
      return;
    }
    if (/\s/.test(key)) {
      errors.push(`Line ${index + 1}: “${key}” contains spaces.`);
      return;
    }
    env[key] = rawLine.slice(rawLine.indexOf('=') + 1).trim();
  });
  return { env, errors };
}

export function formatEnvText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

// ---- Ids ------------------------------------------------------------------------

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `base`, or `base-2`, `base-3`… whichever is not taken (case-insensitive). */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((id) => id.toLowerCase()));
  const root = base || 'item';
  let id = root;
  for (let index = 2; used.has(id.toLowerCase()); index += 1) {
    id = `${root}-${index}`;
  }
  return id;
}

export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

// ---- Profiles -------------------------------------------------------------------

export type ProfileKind = 'detected' | 'imported' | 'user';

export function profileKind(source: ProfileSource | undefined): ProfileKind {
  if (source === 'detected') return 'detected';
  if (source === 'windows-terminal') return 'imported';
  return 'user';
}

export type ProfileTemplateId = 'pwsh' | 'cmd' | 'gitBash' | 'wsl' | 'ssh' | 'custom';

export const PROFILE_TEMPLATES: ReadonlyArray<{ id: ProfileTemplateId; label: string; input?: { label: string; placeholder: string } }> = [
  { id: 'pwsh', label: 'PowerShell' },
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'gitBash', label: 'Git Bash' },
  { id: 'wsl', label: 'WSL', input: { label: 'Distribution', placeholder: 'Ubuntu' } },
  { id: 'ssh', label: 'SSH host', input: { label: 'Host', placeholder: 'user@host' } },
  { id: 'custom', label: 'Custom' },
];

function quoteArgument(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Parses `user@host`, `host` or `user@host:2222`. Returns null when invalid. */
export function parseSshTarget(input: string): { target: string; host: string; port?: number } | null {
  const trimmed = input.trim().replace(/^ssh(?:\.exe)?\s+/i, '');
  const match = /^((?:[^\s@:]+@)?)(\[[^\]\s]+\]|[^\s@:]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!match) return null;
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { target: `${match[1]}${match[2]}`, host: match[2].replace(/^\[|\]$/g, ''), port };
}

export type TemplateResult = { profile: ProfileDefinition } | { error: string };

export function profileFromTemplate(template: ProfileTemplateId, input: string, takenIds: Iterable<string>): TemplateResult {
  let name: string;
  let commandline: string;
  let shellKind: ShellKind;

  switch (template) {
    case 'pwsh':
      name = 'PowerShell';
      commandline = 'pwsh.exe -NoLogo';
      shellKind = 'pwsh';
      break;
    case 'cmd':
      name = 'Command Prompt';
      commandline = '%SystemRoot%\\System32\\cmd.exe';
      shellKind = 'cmd';
      break;
    case 'gitBash':
      name = 'Git Bash';
      commandline = '"%ProgramFiles%\\Git\\bin\\bash.exe" -i -l';
      shellKind = 'bash';
      break;
    case 'wsl': {
      const distro = input.trim();
      if (!distro) return { error: 'Enter a distribution name, e.g. Ubuntu.' };
      name = distro;
      commandline = `wsl.exe -d ${quoteArgument(distro)}`;
      shellKind = 'wsl';
      break;
    }
    case 'ssh': {
      const parsed = parseSshTarget(input);
      if (!parsed) return { error: 'Enter user@host (optionally :port).' };
      name = parsed.host;
      commandline = `ssh.exe ${parsed.target}${parsed.port ? ` -p ${parsed.port}` : ''}`;
      shellKind = 'ssh';
      break;
    }
    default:
      name = 'New profile';
      commandline = 'cmd.exe';
      shellKind = 'other';
  }

  const id = uniqueId(slugify(template === 'ssh' ? `ssh-${name}` : template === 'wsl' ? `wsl-${name}` : name) || 'profile', takenIds);
  return { profile: { id, name, commandline, shellKind, source: 'user' } };
}

export function duplicateProfile(profile: ProfileDefinition, takenIds: Iterable<string>): ProfileDefinition {
  const copy: ProfileDefinition = structuredClone(profile);
  copy.id = uniqueId(`${profile.id}-copy`, takenIds);
  copy.name = `${profile.name} (copy)`;
  copy.source = 'user';
  delete copy.wtGuid;
  delete copy.hidden;
  return copy;
}

// ---- Color schemes --------------------------------------------------------------

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Imported';
}

/** Parses an `.itermcolors` plist or a WT settings/scheme JSON file. Throws with a readable message. */
export function importSchemesFromFile(fileName: string, text: string): ColorScheme[] {
  const trimmed = text.trim();
  if (/\.itermcolors$/i.test(fileName) || trimmed.startsWith('<')) {
    return [parseItermColors(text, baseName(fileName))];
  }

  let json: unknown;
  try {
    // WT settings.json allows comments and trailing commas.
    json = JSON.parse(stripJsonComments(text));
  } catch {
    throw new Error(`${fileName} is not valid JSON.`);
  }
  const schemes = parseWtSchemes(json);
  if (!schemes.length) {
    throw new Error(`${fileName} has no complete color schemes (each needs a name and all 18 colors).`);
  }
  return schemes;
}

/** Removes line and block comments outside strings, then trailing commas (JSONC). */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      result += char;
      if (char === '\\') {
        result += next ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      result += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
    } else {
      result += char;
    }
  }
  return result.replace(/,(\s*[}\]])/g, '$1');
}

/** Incoming schemes replace existing ones with the same (case-insensitive) name. */
export function mergeSchemes(existing: readonly ColorScheme[], incoming: readonly ColorScheme[]): ColorScheme[] {
  const names = new Set(incoming.map((scheme) => scheme.name.toLowerCase()));
  return [...existing.filter((scheme) => !names.has(scheme.name.toLowerCase())), ...incoming];
}

export const SCHEME_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
] as const satisfies ReadonlyArray<keyof ColorScheme>;

// ---- Fonts ----------------------------------------------------------------------

export function isPropoFont(face: string): boolean {
  return /\bpropo\b/i.test(face);
}

/** For `X Nerd Font Propo`, the installed fixed-width sibling (`X Nerd Font Mono`, then `X Nerd Font`). */
export function monoAlternative(face: string, installed: readonly string[]): string | null {
  if (!isPropoFont(face)) return null;
  const stem = face.replace(/\s*\bpropo\b/i, '').trim();
  const lower = new Map(installed.map((name) => [name.toLowerCase(), name]));
  return lower.get(`${stem} mono`.toLowerCase()) ?? lower.get(stem.toLowerCase()) ?? null;
}
