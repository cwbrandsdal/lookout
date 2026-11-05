// First-run settings: detected shells + Windows Terminal import + Lookout v1
// migration, merged into one LookoutSettings. buildInitialSettings is pure;
// runFirstRun gathers its inputs and never throws.

import { win32 } from 'node:path';

import { BUILTIN_SCHEMES } from '../src/shared/color-schemes';
import { expandEnvVars, splitCommandLine } from '../src/shared/commandline';
import type { ColorScheme, FontSettings, KeybindingEntry, LookoutSettings, ProfileDefinition } from '../src/shared/settings';
import { createDefaultSettings, DEFAULT_FONT_FACE, FALLBACK_PROFILE_IDS, sanitizeSettings } from '../src/shared/settings-defaults';
import type { V1Migration } from './migrate-v1';
import { detectProfiles as defaultDetectProfiles } from './profiles/detect';
import { importWindowsTerminal as defaultImportWindowsTerminal, type WtImportResult } from './profiles/windows-terminal';

export interface FirstRunInput {
  defaults: LookoutSettings;
  detected: ProfileDefinition[];
  wtImport: WtImportResult | null;
  v1: V1Migration | null;
  /** Used to compare command lines (`%SystemRoot%` etc.). Default: SystemRoot/windir = C:\Windows. */
  env?: Record<string, string | undefined>;
}

export interface FirstRunResult {
  settings: LookoutSettings;
  summary: string[];
  /** Tabs from Windows Terminal's saved window layout (state.json), if it kept one. */
  wtLayouts?: WtImportResult['layouts'];
}

/**
 * Nerd Font "Propo" variants are proportional and misalign in a terminal grid; the
 * plain "Nerd Font" family has the same glyphs at a fixed advance. Registry-style
 * names ("… Regular") are reduced to the family name.
 */
export function normalizeTerminalFontFace(face: string): string {
  let result = face.trim().replace(/\s+/g, ' ').replace(/ Regular$/i, '');
  result = result.replace(/ Nerd Font Propo\b/i, ' Nerd Font');
  return result.trim();
}

interface CommandKey {
  exe: string;
  base: string;
  args: string;
  absolute: boolean;
}

function commandKey(commandline: string, env: Record<string, string | undefined>): CommandKey | null {
  const [exe, ...args] = splitCommandLine(expandEnvVars(commandline.trim(), env));
  if (!exe) return null;
  const normalized = win32.normalize(exe).toLowerCase();
  return {
    exe: normalized.replace(/\.exe$/, ''),
    base: win32.basename(normalized).replace(/\.exe$/, ''),
    args: args.join('\u0000').toLowerCase(),
    absolute: win32.isAbsolute(normalized),
  };
}

function sameCommand(left: string, right: string, env: Record<string, string | undefined>): boolean {
  const a = commandKey(left, env);
  const b = commandKey(right, env);
  if (!a || !b || a.args !== b.args) return false;
  return a.absolute && b.absolute ? a.exe === b.exe : a.base === b.base;
}

function sameScheme(left: ColorScheme, right: ColorScheme): boolean {
  return (Object.keys(left) as Array<keyof ColorScheme>).every((key) =>
    key === 'name' ? left.name.toLowerCase() === right.name.toLowerCase() : left[key].toLowerCase() === right[key]?.toLowerCase());
}

function withNormalizedFont(profile: ProfileDefinition): ProfileDefinition {
  if (!profile.font?.face) return profile;
  return { ...profile, font: { ...profile.font, face: normalizeTerminalFontFace(profile.font.face) } };
}

export function buildInitialSettings(input: FirstRunInput): FirstRunResult {
  const { defaults, detected, wtImport, v1 } = input;
  const env = input.env ?? { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' };
  const summary: string[] = [];

  // ---- Profiles ----
  // Detected shells (or the built-in fallbacks when detection found nothing)...
  const base = detected.length ? detected.map((profile) => ({ ...profile })) : defaults.profiles.map((profile) => ({ ...profile }));
  summary.push(detected.length
    ? `Detected ${detected.length} shell profile(s).`
    : 'Shell detection found nothing; using the built-in PowerShell / Windows PowerShell / Command Prompt profiles.');

  // ...overridden by Windows Terminal profiles (WT order first: that is the order the user knows).
  const idMap = new Map<string, string>();
  const ordered: ProfileDefinition[] = [];
  const consumed = new Set<string>();
  for (const wtProfile of wtImport?.profiles ?? []) {
    const match = base.find((profile) => !consumed.has(profile.id) && profile.id === wtProfile.id)
      ?? base.find((profile) => !consumed.has(profile.id) && sameCommand(profile.commandline, wtProfile.commandline, env));
    const id = match?.id ?? wtProfile.id;
    idMap.set(wtProfile.id, id);
    if (match) consumed.add(match.id);
    if (ordered.some((profile) => profile.id === id)) continue;
    ordered.push(withNormalizedFont({ ...match, ...wtProfile, id, source: 'windows-terminal' }));
  }
  const profiles = [...ordered, ...base.filter((profile) => !consumed.has(profile.id) && !ordered.some((entry) => entry.id === profile.id))];
  if (wtImport) {
    summary.push(`Imported ${wtImport.profiles.length} Windows Terminal profile(s) from ${wtImport.sourcePath}.`);
  }

  // ...plus whatever migrated v1 panes need.
  if (v1) {
    for (const needed of v1.profiles) {
      if (profiles.some((profile) => profile.id === needed.id)) continue;
      const duplicate = profiles.some((profile) => sameCommand(profile.commandline, needed.commandline, env));
      // Keep the id resolvable for migrated panes, but do not list the same shell twice.
      profiles.push({ ...needed, ...(duplicate ? { hidden: true } : {}) });
    }
    if (v1.referencedProfileIds.includes('pwsh') && !profiles.some((profile) => profile.id === 'pwsh')) {
      // v1 started `pwsh`, falling back to Windows PowerShell; keep that behaviour for migrated panes.
      const windowsPowerShell = profiles.find((profile) => profile.id === 'windows-powershell');
      profiles.push({
        id: 'pwsh',
        name: 'PowerShell',
        commandline: windowsPowerShell?.commandline ?? '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        shellKind: 'powershell',
        hidden: true,
        source: 'migrated',
      });
      summary.push('PowerShell 7 was not found; migrated v1 panes will use Windows PowerShell.');
    }
  }

  // ---- Default profile ----
  // WT's default, else pwsh, else Windows PowerShell, else cmd, else the first visible profile.
  const wtDefault = wtImport?.defaultProfileId ? idMap.get(wtImport.defaultProfileId) ?? wtImport.defaultProfileId : undefined;
  const visible = (id: string | undefined) => profiles.some((profile) => profile.id === id && !profile.hidden);
  const defaultProfile = [wtDefault, ...FALLBACK_PROFILE_IDS].find(visible)
    ?? profiles.find((profile) => !profile.hidden)?.id ?? 'pwsh';

  // ---- Font ---- (defaults < v1 < WT `profiles.defaults`)
  const font: FontSettings = { ...defaults.font };
  let fontSource = 'default';
  if (v1) {
    const { face, ...metrics } = v1.font;
    Object.assign(font, metrics);
    if (face) {
      font.face = normalizeTerminalFontFace(face);
      fontSource = font.face === face ? 'Lookout v1' : `Lookout v1 ("${face}")`;
    }
  }
  if (wtImport?.font) {
    const { face, ...metrics } = wtImport.font;
    Object.assign(font, metrics);
    if (face) {
      font.face = normalizeTerminalFontFace(face);
      fontSource = 'Windows Terminal';
    }
  }
  if (!font.face.trim()) font.face = DEFAULT_FONT_FACE;
  summary.push(`Terminal font: ${font.face} ${font.size}pt (${fontSource}).`);

  // ---- Schemes ---- (WT schemes appended; exact copies of built-ins are noise)
  const schemes = [...defaults.schemes];
  for (const scheme of wtImport?.schemes ?? []) {
    if (BUILTIN_SCHEMES.some((builtin) => sameScheme(builtin, scheme))) continue;
    const index = schemes.findIndex((entry) => entry.name.toLowerCase() === scheme.name.toLowerCase());
    if (index >= 0) schemes[index] = scheme;
    else schemes.push(scheme);
  }
  if (wtImport?.schemes.length) summary.push(`Imported ${schemes.length - defaults.schemes.length} custom color scheme(s) from Windows Terminal.`);

  // ---- Keybindings ---- (already mapped to Lookout commands; profile references remapped)
  const keybindings = new Map<string, KeybindingEntry>(defaults.keybindings.map((entry) => [entry.keys, entry]));
  for (const entry of wtImport?.keybindings ?? []) {
    const profile = entry.args?.profile;
    const args = typeof profile === 'string' && idMap.has(profile) ? { ...entry.args, profile: idMap.get(profile)! } : entry.args;
    keybindings.delete(entry.keys);
    keybindings.set(entry.keys, { ...entry, ...(args ? { args } : {}) });
  }
  if (wtImport?.keybindings.length) summary.push(`Imported ${wtImport.keybindings.length} Windows Terminal keybinding(s).`);
  for (const warning of wtImport?.warnings ?? []) summary.push(`Windows Terminal: ${warning}`);

  if (v1) {
    summary.push(`Migrated ${v1.stats.spaces} Lookout v1 project space(s) to workspaces (${v1.stats.openSpaces} reopened as tabs).`);
    for (const warning of v1.warnings) summary.push(`Lookout v1: ${warning}`);
  }

  const draft: LookoutSettings = {
    ...defaults,
    profiles,
    defaultProfile,
    font,
    schemes,
    keybindings: [...keybindings.values()],
    window: { ...defaults.window, ...(v1 ? { restoreSession: v1.restoreSession } : {}) },
  };
  const { settings, warnings } = sanitizeSettings(draft, defaults);
  for (const warning of warnings) summary.push(`Adjusted: ${warning}`);
  return { settings, summary };
}

export interface FirstRunDeps {
  defaults?: LookoutSettings;
  /** The v1 migration (StateStore.getV1Migration()), or a loader for it. */
  v1?: V1Migration | null | (() => V1Migration | null | Promise<V1Migration | null>);
  detectProfiles?: () => Promise<ProfileDefinition[]>;
  importWindowsTerminal?: (options: { detected: ProfileDefinition[] }) => Promise<WtImportResult | null>;
  env?: Record<string, string | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Gathers first-run inputs (each step isolated by try/catch) and builds the initial settings. */
export async function runFirstRun(deps: FirstRunDeps = {}): Promise<FirstRunResult> {
  const failures: string[] = [];
  const defaults = deps.defaults ?? createDefaultSettings();

  let detected: ProfileDefinition[] = [];
  try {
    detected = await (deps.detectProfiles ?? (() => defaultDetectProfiles()))();
  } catch (error) {
    failures.push(`Shell detection failed: ${errorMessage(error)}`);
  }

  let wtImport: WtImportResult | null = null;
  try {
    wtImport = await (deps.importWindowsTerminal ?? defaultImportWindowsTerminal)({ detected });
  } catch (error) {
    failures.push(`Windows Terminal import failed: ${errorMessage(error)}`);
  }

  let v1: V1Migration | null = null;
  try {
    v1 = typeof deps.v1 === 'function' ? await deps.v1() : deps.v1 ?? null;
  } catch (error) {
    failures.push(`Lookout v1 migration failed: ${errorMessage(error)}`);
  }

  const result = buildInitialSettings({ defaults, detected, wtImport, v1, env: deps.env ?? process.env });
  return { settings: result.settings, summary: [...failures, ...result.summary], wtLayouts: wtImport?.layouts ?? [] };
}
