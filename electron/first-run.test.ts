import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_SCHEMES } from '../src/shared/color-schemes';
import type { ColorScheme, ProfileDefinition } from '../src/shared/settings';
import { createDefaultSettings } from '../src/shared/settings-defaults';
import { buildInitialSettings, normalizeTerminalFontFace, runFirstRun } from './first-run';
import type { V1Migration } from './migrate-v1';
import type { WtImportResult } from './profiles/windows-terminal';

const env = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' };

const DETECTED: ProfileDefinition[] = [
  { id: 'pwsh', name: 'PowerShell', commandline: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', shellKind: 'pwsh', source: 'detected' },
  { id: 'windows-powershell', name: 'Windows PowerShell', commandline: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', shellKind: 'powershell', source: 'detected' },
  { id: 'cmd', name: 'Command Prompt', commandline: 'C:\\Windows\\System32\\cmd.exe', shellKind: 'cmd', source: 'detected' },
  { id: 'git-bash', name: 'Git Bash', commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', shellKind: 'bash', source: 'detected' },
  { id: 'wsl-ubuntu', name: 'Ubuntu', commandline: 'wsl.exe -d Ubuntu', shellKind: 'wsl', startingDirectory: '~', source: 'detected' },
];

const MINE: ColorScheme = { ...BUILTIN_SCHEMES[0], name: 'Mine', background: '#101010' };

function wtImport(overrides: Partial<WtImportResult> = {}): WtImportResult {
  return {
    sourcePath: 'C:\\Users\\me\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json',
    profiles: [
      // Static WT entries (ids are WT name slugs) and a dynamic one (detected id).
      {
        id: 'windows-powershell', name: 'Windows PowerShell', commandline: '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        shellKind: 'powershell', font: { face: 'MesloLGL Nerd Font Propo' }, source: 'windows-terminal', wtGuid: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}',
      },
      { id: 'command-prompt', name: 'Command Prompt', commandline: '%SystemRoot%\\System32\\cmd.exe', shellKind: 'cmd', hidden: true, source: 'windows-terminal' },
      { ...DETECTED[0], name: 'PowerShell 7', colorScheme: 'One Half Dark', source: 'windows-terminal', wtGuid: '{574e775e-4f2a-5b96-ac1e-a2962a402336}' },
      { id: 'my-ssh', name: 'My SSH', commandline: 'ssh.exe me@host', shellKind: 'ssh', source: 'windows-terminal' },
    ],
    defaultProfileId: 'pwsh',
    schemes: [MINE, { ...BUILTIN_SCHEMES[0] }],
    font: { face: 'MesloLGM Nerd Font' },
    keybindings: [
      { keys: 'ctrl+shift+1', command: 'newTab', args: { profile: 'command-prompt' } },
      { keys: 'ctrl+w', command: null },
    ],
    layouts: [],
    warnings: ['Skipped "Azure Cloud Shell": Windows.Terminal.Azure is unsupported or its shell is not installed.'],
    ...overrides,
  };
}

function v1(overrides: Partial<V1Migration> = {}): V1Migration {
  return {
    workspaces: [],
    window: null,
    font: { face: 'MesloLGL Nerd Font Propo', size: 14, lineHeight: 1, letterSpacing: 0 },
    recentDirectories: [],
    profiles: [
      { id: 'v1-cmd', name: 'cmd', commandline: 'cmd.exe', source: 'migrated' },
      { id: 'v1-nu', name: 'nu', commandline: '"C:\\Tools\\nu.exe" --login', source: 'migrated' },
    ],
    referencedProfileIds: ['pwsh', 'v1-cmd', 'v1-nu'],
    restoreSession: false,
    warnings: [],
    stats: { spaces: 3, openSpaces: 2, pinnedOpenSpaces: 1, panes: 5, customTitles: 0, startupCommands: 4, presetsSkipped: 3 },
    ...overrides,
  };
}

describe('normalizeTerminalFontFace', () => {
  it('maps proportional Nerd Font variants and registry style names to the family', () => {
    expect(normalizeTerminalFontFace('MesloLGL Nerd Font Propo')).toBe('MesloLGL Nerd Font');
    expect(normalizeTerminalFontFace('MesloLGMDZ Nerd Font Propo Regular')).toBe('MesloLGMDZ Nerd Font');
    expect(normalizeTerminalFontFace('MesloLGL Nerd Font Regular')).toBe('MesloLGL Nerd Font');
    expect(normalizeTerminalFontFace('JetBrainsMono Nerd Font Mono')).toBe('JetBrainsMono Nerd Font Mono');
    expect(normalizeTerminalFontFace('Cascadia Code')).toBe('Cascadia Code');
  });
});

describe('buildInitialSettings', () => {
  it('merges detected + Windows Terminal + v1 (WT overrides win)', () => {
    const { settings, summary } = buildInitialSettings({ defaults: createDefaultSettings(), detected: DETECTED, wtImport: wtImport(), v1: v1(), env });

    // WT order first, then the remaining detected shells, then migrated v1 needs.
    expect(settings.profiles.map((profile) => profile.id)).toEqual(['windows-powershell', 'cmd', 'pwsh', 'my-ssh', 'git-bash', 'wsl-ubuntu', 'v1-cmd', 'v1-nu']);
    const byId = Object.fromEntries(settings.profiles.map((profile) => [profile.id, profile]));
    // WT "Command Prompt" matched detected `cmd` by command line, keeps the detected id and WT's hidden flag.
    expect(byId.cmd).toMatchObject({ name: 'Command Prompt', hidden: true, source: 'windows-terminal', commandline: '%SystemRoot%\\System32\\cmd.exe' });
    expect(byId.pwsh).toMatchObject({ name: 'PowerShell 7', colorScheme: 'One Half Dark', source: 'windows-terminal' });
    // Propo per-profile font from WT is mapped too.
    expect(byId['windows-powershell'].font).toEqual({ face: 'MesloLGL Nerd Font' });
    expect(byId['wsl-ubuntu']).toEqual(DETECTED[4]);
    // A migrated shell that duplicates a known one stays resolvable but hidden.
    expect(byId['v1-cmd'].hidden).toBe(true);
    expect(byId['v1-nu'].hidden).toBeUndefined();

    expect(settings.defaultProfile).toBe('pwsh');
    // WT profiles.defaults font beats v1; v1 metrics beat the defaults.
    expect(settings.font).toMatchObject({ face: 'MesloLGM Nerd Font', size: 14, lineHeight: 1, letterSpacing: 0 });
    // Built-in copies are not duplicated.
    expect(settings.schemes.map((scheme) => scheme.name)).toEqual(['Mine']);
    expect(settings.keybindings).toEqual([
      { keys: 'ctrl+shift+1', command: 'newTab', args: { profile: 'cmd' } },
      { keys: 'ctrl+w', command: null },
    ]);
    expect(settings.window.restoreSession).toBe(false);
    expect(settings.colorScheme).toBe('Lookout Night');

    expect(summary.some((line) => line.includes('Detected 5'))).toBe(true);
    expect(summary.some((line) => line.includes('Imported 4 Windows Terminal profile'))).toBe(true);
    expect(summary.some((line) => line.includes('MesloLGM Nerd Font 14pt (Windows Terminal)'))).toBe(true);
    expect(summary.some((line) => line.startsWith('Windows Terminal: Skipped'))).toBe(true);
    expect(summary.some((line) => line.includes('Migrated 3 Lookout v1'))).toBe(true);
    expect(summary.some((line) => line.startsWith('Adjusted'))).toBe(false);
  });

  it('remaps a WT default that matched a detected profile by command line', () => {
    const { settings } = buildInitialSettings({
      defaults: createDefaultSettings(), detected: DETECTED, v1: null, env,
      wtImport: wtImport({ defaultProfileId: 'command-prompt', profiles: [{ id: 'command-prompt', name: 'CMD', commandline: 'cmd.exe' }] }),
    });
    expect(settings.defaultProfile).toBe('cmd');
    expect(settings.profiles[0]).toMatchObject({ id: 'cmd', name: 'CMD' });
  });

  it('uses the v1 font (Propo mapped) without WT, and Cascadia Mono without either', () => {
    const fromV1 = buildInitialSettings({ defaults: createDefaultSettings(), detected: DETECTED, wtImport: null, v1: v1(), env });
    expect(fromV1.settings.font).toMatchObject({ face: 'MesloLGL Nerd Font', size: 14, lineHeight: 1 });
    expect(fromV1.summary.some((line) => line.includes('Lookout v1 ("MesloLGL Nerd Font Propo")'))).toBe(true);
    expect(fromV1.settings.profiles.map((profile) => profile.id).slice(0, 5)).toEqual(DETECTED.map((profile) => profile.id));

    const plain = buildInitialSettings({ defaults: createDefaultSettings(), detected: DETECTED, wtImport: null, v1: null, env });
    expect(plain.settings.font.face).toBe('Cascadia Mono');
    expect(plain.settings.font.lineHeight).toBe(1.1);
    expect(plain.settings.defaultProfile).toBe('pwsh');
    expect(plain.settings.window.restoreSession).toBe(true);
  });

  it('falls back to built-in profiles when detection found nothing', () => {
    const { settings, summary } = buildInitialSettings({ defaults: createDefaultSettings(), detected: [], wtImport: null, v1: null, env });
    expect(settings.profiles.map((profile) => profile.id)).toEqual(['pwsh', 'windows-powershell', 'cmd']);
    expect(settings.defaultProfile).toBe('pwsh');
    expect(summary[0]).toContain('built-in');
  });

  it('keeps migrated pwsh panes working without PowerShell 7 and defaults to Windows PowerShell', () => {
    const detected = DETECTED.filter((profile) => profile.id !== 'pwsh');
    const { settings, summary } = buildInitialSettings({ defaults: createDefaultSettings(), detected, wtImport: null, v1: v1({ profiles: [], referencedProfileIds: ['pwsh'] }), env });
    const alias = settings.profiles.find((profile) => profile.id === 'pwsh');
    expect(alias).toMatchObject({ hidden: true, source: 'migrated', commandline: DETECTED[1].commandline });
    expect(settings.defaultProfile).toBe('windows-powershell');
    expect(summary.some((line) => line.includes('PowerShell 7 was not found'))).toBe(true);
  });
});

describe('runFirstRun', () => {
  it('feeds detection into the WT import and survives failing steps', async () => {
    const importWindowsTerminal = vi.fn<(options: { detected: ProfileDefinition[] }) => Promise<WtImportResult | null>>(async () => {
      throw new Error('WT exploded');
    });
    const result = await runFirstRun({
      detectProfiles: async () => DETECTED,
      importWindowsTerminal,
      v1: () => {
        throw new Error('v1 exploded');
      },
      env,
    });
    expect(importWindowsTerminal).toHaveBeenCalledWith({ detected: DETECTED });
    expect(result.summary[0]).toContain('WT exploded');
    expect(result.summary[1]).toContain('v1 exploded');
    expect(result.settings.profiles.map((profile) => profile.id)).toEqual(DETECTED.map((profile) => profile.id));
  });

  // Opt-in, read-only: real shell detection + Windows Terminal import (+ LOOKOUT_V1_SAMPLE if set).
  it.skipIf(!process.env.LOOKOUT_FIRST_RUN_LIVE)('runs against this machine', async () => {
    const { readFile } = await import('node:fs/promises');
    const { migrateV1 } = await import('./migrate-v1');
    const sample = process.env.LOOKOUT_V1_SAMPLE;
    const result = await runFirstRun({ v1: sample ? migrateV1(JSON.parse(await readFile(sample, 'utf8'))) : null });
    console.log(JSON.stringify({
      defaultProfile: result.settings.defaultProfile,
      font: result.settings.font,
      profiles: result.settings.profiles.map((profile) => `${profile.id}${profile.hidden ? ' (hidden)' : ''} [${profile.source}]`),
      schemes: result.settings.schemes.map((scheme) => scheme.name),
      keybindings: result.settings.keybindings.length,
      restoreSession: result.settings.window.restoreSession,
      summary: result.summary,
    }, null, 2));
    expect(result.settings.profiles.length).toBeGreaterThan(0);
  }, 60_000);

  it('accepts a v1 migration value and a failing detector', async () => {
    const result = await runFirstRun({
      detectProfiles: async () => {
        throw new Error('no shells');
      },
      importWindowsTerminal: async () => null,
      v1: v1(),
      env,
    });
    expect(result.summary[0]).toContain('no shells');
    expect(result.settings.font.face).toBe('MesloLGL Nerd Font');
    expect(result.settings.profiles.some((profile) => profile.id === 'v1-nu')).toBe(true);
  });
});
