import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileDefinition } from '../../src/shared/settings';
import { BUILTIN_SCHEMES } from '../../src/shared/color-schemes';
import { importWindowsTerminal } from './windows-terminal';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const detected: ProfileDefinition[] = [
  { id: 'pwsh', name: 'PowerShell', commandline: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', source: 'detected', shellKind: 'pwsh' },
  { id: 'windows-powershell', name: 'Windows PowerShell', commandline: 'powershell.exe', source: 'detected', shellKind: 'powershell' },
  { id: 'cmd', name: 'Command Prompt', commandline: 'cmd.exe', source: 'detected', shellKind: 'cmd' },
  { id: 'wsl-ubuntu', name: 'Ubuntu', commandline: 'wsl.exe -d Ubuntu', startingDirectory: '~', source: 'detected', shellKind: 'wsl' },
  { id: 'vs-cmd-preview', name: 'Developer Command Prompt for VS 18 [Preview]', commandline: 'cmd.exe /k "C:\\VS\\VsDevCmd.bat"', source: 'detected', shellKind: 'cmd' },
  { id: 'vs-powershell-preview', name: 'Developer PowerShell for VS 18 [Preview]', commandline: 'powershell.exe -NoExit -Command "devshell"', source: 'detected', shellKind: 'powershell' },
];

// The real settings file's shape, profile order, GUIDs, and modern action IDs.
const realSettings = {
  $help: 'https://aka.ms/terminal-documentation', $schema: 'https://aka.ms/terminal-profiles-schema',
  actions: [], copyFormatting: 'none', copyOnSelect: false,
  defaultProfile: '{574e775e-4f2a-5b96-ac1e-a2962a402336}',
  keybindings: [
    { id: 'Terminal.CopyToClipboard', keys: 'ctrl+c' },
    { id: 'Terminal.PasteFromClipboard', keys: 'ctrl+v' },
    { id: 'Terminal.FindText', keys: 'ctrl+shift+f' },
    { id: 'Terminal.DuplicatePaneAuto', keys: 'alt+shift+d' },
  ],
  newTabMenu: [{ type: 'remainingProfiles' }],
  profiles: {
    defaults: { font: { face: 'MesloLGM Nerd Font' } },
    list: [
      { commandline: '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', font: { face: 'MesloLGL Nerd Font Propo' }, guid: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}', hidden: false, name: 'Windows PowerShell' },
      { commandline: '%SystemRoot%\\System32\\cmd.exe', guid: '{0caa0dad-35be-5f56-a8ff-afceeeaa6101}', hidden: false, name: 'Command Prompt' },
      { guid: '{b453ae62-4e3d-5e58-b989-0a998ec441b8}', hidden: false, name: 'Azure Cloud Shell', source: 'Windows.Terminal.Azure' },
      { guid: '{16d7aea9-f9c6-5063-b5f1-248e624f3488}', hidden: false, name: 'Developer Command Prompt for VS 18 [Preview]', source: 'Windows.Terminal.VisualStudio' },
      { guid: '{0a418d58-a626-58ee-b52b-276685710cb9}', hidden: false, name: 'Developer PowerShell for VS 18 [Preview]', source: 'Windows.Terminal.VisualStudio' },
      { guid: '{92a06129-939f-5f29-ae94-798c3316e807}', hidden: true, name: 'Developer Command Prompt for VS 2019', source: 'Windows.Terminal.VisualStudio' },
      { guid: '{8eac670c-ed1f-565e-b108-911aa1b94aeb}', hidden: true, name: 'Developer PowerShell for VS 2019', source: 'Windows.Terminal.VisualStudio' },
      { guid: '{16208362-94fc-5b1f-a491-5b2624d5ab56}', hidden: true, name: 'Visual Studio Debug Console', source: 'VSDebugConsole' },
      { guid: '{9513e8f8-94a4-5466-af37-10275f22ffa2}', hidden: false, name: 'Ubuntu', source: 'Microsoft.WSL' },
      { commandline: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe alex@10.0.0.5', guid: '{9a745fb3-7218-42ab-9abc-2f81a00a7b43}', hidden: false, name: 'SSH devbox' },
      { guid: '{574e775e-4f2a-5b96-ac1e-a2962a402336}', hidden: false, name: 'PowerShell', source: 'Windows.Terminal.PowershellCore' },
    ],
  },
  schemes: [], themes: [],
};

async function fixture(settings: unknown, state?: unknown, edition: 'stable' | 'preview' | 'unpackaged' = 'stable') {
  const folder = await mkdtemp(join(tmpdir(), 'lookout-wt-'));
  folders.push(folder);
  const path = edition === 'unpackaged' ? join(folder, 'Microsoft', 'Windows Terminal', 'settings.json')
    : join(folder, 'Packages', edition === 'stable' ? 'Microsoft.WindowsTerminal_8wekyb3d8bbwe' : 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof settings === 'string' ? settings : JSON.stringify(settings));
  if (state !== undefined) await writeFile(join(dirname(path), 'state.json'), JSON.stringify(state));
  return { path, env: { LOCALAPPDATA: folder } };
}

describe('importWindowsTerminal', () => {
  it('imports the real-user fixture with dynamic resolution and modern Terminal.* bindings', async () => {
    const { env, path } = await fixture(realSettings);
    const snapshot = structuredClone(detected);
    const result = await importWindowsTerminal({ env, detected });
    expect(result?.sourcePath).toBe(path);
    expect(result?.profiles).toHaveLength(7);
    expect(result?.profiles.every((profile) => profile.source === 'windows-terminal' && profile.wtGuid)).toBe(true);
    expect(result?.defaultProfileId).toBe('pwsh');
    expect(result?.font).toEqual({ face: 'MesloLGM Nerd Font' });
    expect(result?.profiles.find((profile) => profile.name === 'Windows PowerShell')?.font).toEqual({ face: 'MesloLGL Nerd Font Propo' });
    expect(result?.profiles.find((profile) => profile.id === 'pwsh')).toMatchObject({ commandline: detected[0].commandline, font: { face: 'MesloLGM Nerd Font' }, shellKind: 'pwsh' });
    expect(result?.profiles.find((profile) => profile.id === 'wsl-ubuntu')).toMatchObject({ startingDirectory: '~', commandline: 'wsl.exe -d Ubuntu' });
    expect(result?.profiles.find((profile) => profile.id === 'ssh-devbox')).toMatchObject({ shellKind: 'ssh', commandline: realSettings.profiles.list[9].commandline });
    expect(result?.keybindings).toEqual([
      { keys: 'ctrl+c', command: 'copy' }, { keys: 'ctrl+v', command: 'paste' },
      { keys: 'ctrl+shift+f', command: 'find' }, { keys: 'alt+shift+d', command: 'splitAuto' },
    ]);
    expect(result?.layouts).toEqual([]);
    expect(result?.warnings).toHaveLength(4);
    expect(result?.warnings.join(' ')).toContain('Azure Cloud Shell');
    expect(result?.warnings.join(' ')).toContain('2019');
    expect(detected).toEqual(snapshot);
  });

  it('fills defaults field-by-field, applies overrides, preserves hidden profiles and resolves built-in schemes', async () => {
    const { env } = await fixture({
      defaultProfile: '{PWSH}',
      profiles: {
        defaults: { font: { face: 'Default', size: 12, weight: 600 }, colorScheme: 'Campbell', startingDirectory: '%USERPROFILE%', cursorShape: 'filledBox', closeOnExit: 'automatic', elevate: true },
        list: [
          { guid: '{pwsh}', source: 'Windows.Terminal.PowershellCore', name: 'My PowerShell', hidden: true, font: { size: 16 }, cursorShape: 'underscore', tabColor: '#123456', icon: '🔥', closeOnExit: 'never', elevate: false },
          { guid: '{second}', name: 'My PowerShell', commandline: 'cmd.exe', icon: 'C:\\icons\\cmd.png', fontFace: 'Legacy' },
          { guid: '{third}', name: 'My PowerShell', commandline: 'cmd.exe' },
        ],
      },
      schemes: [{ ...BUILTIN_SCHEMES[0], name: 'Custom' }],
    });
    const result = await importWindowsTerminal({ env, detected });
    expect(result?.defaultProfileId).toBe('pwsh');
    expect(result?.profiles[0]).toMatchObject({ id: 'pwsh', name: 'My PowerShell', font: { face: 'Default', size: 16, weight: '600' }, hidden: true, cursorStyle: 'underline', tabColor: '#123456', closeOnExit: 'never', elevate: false, icon: '🔥' });
    expect(result?.profiles[1]).toMatchObject({ id: 'my-powershell', font: { face: 'Legacy', size: 12 }, cursorStyle: 'block', closeOnExit: 'graceful', elevate: true });
    expect(result?.profiles[1].icon).toBeUndefined();
    expect(result?.profiles[2].id).toBe('my-powershell-2');
    expect(result?.profiles.every((profile) => profile.colorScheme === 'Campbell')).toBe(true);
    expect(result?.schemes.map((scheme) => scheme.name)).toEqual(['Custom']);
    expect(result?.warnings).toEqual([]);
  });

  it('maps action forms, custom IDs, parameters, unbinding, chords and the complete requested command set', async () => {
    const actions: unknown[] = [
      { id: 'user.send', command: { action: 'sendInput', input: 'echo hi\r' } },
      { command: { action: 'newTab', index: 0 }, keys: 'alt+1' },
      { command: { action: 'newTab', profile: 'PowerShell' }, keys: 'alt+2' },
      { command: { action: 'switchToTab', index: 4 }, keys: 'alt+3' },
      { command: { action: 'splitPane', split: 'right' }, keys: 'alt+4' },
      { command: { action: 'splitPane', split: 'down' }, keys: 'alt+5' },
      { command: { action: 'splitPane', split: 'auto' }, keys: 'alt+6' },
      { command: { action: 'splitPane', splitMode: 'duplicate', split: 'down' }, keys: 'alt+7' },
      { command: { action: 'moveFocus', direction: 'left' }, keys: 'alt+left' },
      { command: { action: 'resizePane', direction: 'up' }, keys: 'alt+shift+up' },
      { command: { action: 'adjustFontSize', delta: 1 }, keys: 'ctrl+shift+plus' },
      { command: { action: 'adjustFontSize', delta: -1 }, keys: 'alt+shift+minus' },
      { command: { action: 'scrollToMark', direction: 'previous' }, keys: 'ctrl+up' },
      { command: { action: 'scrollToMark', direction: 'next' }, keys: 'ctrl+down' },
      { command: 'quakeMode', keys: 'win+sc(41)' },
      { command: null, keys: 'ctrl+q' },
      { command: 'unknown', keys: 'ctrl+u' },
      { command: 'copy', keys: 'ctrl+sc(99)' },
      { command: 'paste', keys: ['control+plus', 'shift+pgup'] },
    ];
    const simple = ['copy', 'paste', 'find', 'newTab', 'closePane', 'closeTab', 'nextTab', 'prevTab', 'togglePaneZoom', 'commandPalette', 'openSettings', 'toggleFullscreen', 'resetFontSize', 'scrollUp', 'scrollDown', 'scrollUpPage', 'scrollDownPage', 'scrollToTop', 'scrollToBottom', 'renameTab'];
    actions.push(...simple.map((command, index) => ({ command, keys: `ctrl+alt+f${index + 1}` })));
    const { env } = await fixture({ profiles: { list: [realSettings.profiles.list[10]] }, actions,
      keybindings: [{ id: 'user.send', keys: 'alt+s' }, { id: 'Terminal.SwitchToTab2', keys: 'alt+t' }, { id: 'Terminal.PasteFromClipboard', keys: 'ctrl+q' }],
    });
    const result = await importWindowsTerminal({ env, detected });
    const byKey = Object.fromEntries(result!.keybindings.map((binding) => [binding.keys, binding]));
    expect(byKey['alt+1']).toMatchObject({ command: 'newTabProfileIndex', args: { index: 0 } });
    expect(byKey['alt+2']).toMatchObject({ command: 'newTab', args: { profile: 'pwsh' } });
    expect(byKey['alt+3']).toMatchObject({ command: 'switchToTab', args: { index: 4 } });
    expect(byKey['alt+4'].command).toBe('splitRight');
    expect(byKey['alt+5'].command).toBe('splitDown');
    expect(byKey['alt+6'].command).toBe('splitAuto');
    expect(byKey['alt+7'].command).toBe('splitAuto');
    expect(byKey['alt+left']).toMatchObject({ command: 'focusPane', args: { direction: 'left' } });
    expect(byKey['alt+shift+up']).toMatchObject({ command: 'resizePane', args: { direction: 'up' } });
    expect(byKey['ctrl+shift+plus'].command).toBe('fontSizeIncrease');
    expect(byKey['alt+shift+minus'].command).toBe('fontSizeDecrease');
    expect(byKey['ctrl+up'].command).toBe('prevCommand');
    expect(byKey['ctrl+down'].command).toBe('nextCommand');
    expect(byKey['meta+`'].command).toBe('toggleQuake');
    expect(byKey['alt+s']).toMatchObject({ command: 'sendInput', args: { input: 'echo hi\r' } });
    expect(byKey['alt+t']).toMatchObject({ command: 'switchToTab', args: { index: 2 } });
    expect(byKey['ctrl+q'].command).toBe('paste');
    expect(byKey['ctrl+plus'].command).toBe('paste');
    expect(byKey['shift+pageup'].command).toBe('paste');
    expect(result?.warnings).toHaveLength(2);
    for (const command of ['copy', 'paste', 'find', 'newTab', 'closePane', 'closeTab', 'nextTab', 'prevTab', 'togglePaneZoom', 'commandPalette', 'openSettings', 'toggleFullscreen', 'fontSizeReset', 'scrollUp', 'scrollDown', 'scrollPageUp', 'scrollPageDown', 'scrollToTop', 'scrollToBottom', 'renameTab']) {
      expect(result?.keybindings.some((binding) => binding.command === command)).toBe(true);
    }
  });

  it('remaps visible profile indices after unsupported profiles are skipped and reads persisted actions', async () => {
    const { env } = await fixture({
      profiles: { list: [realSettings.profiles.list[2], realSettings.profiles.list[10], realSettings.profiles.list[8]] },
      actions: [{ command: { action: 'newTab', index: 1 }, keys: 'ctrl+1' }, { command: { action: 'newTab', index: 0 }, keys: 'ctrl+2' }],
    }, { persistedWindowLayouts: [{ tabLayout: [
      { action: 'newTab', profile: '{574e775e-4f2a-5b96-ac1e-a2962a402336}', startingDirectory: 'C:\\work', tabTitle: 'Work' },
      { action: 'splitPane', split: 'right', profile: 'Ubuntu', startingDirectory: '~' },
      { action: 'splitPane', split: 'down', commandline: 'cmd.exe' },
      { action: 'renameTab', title: 'Renamed' },
      { action: 'newTab', profile: 'PowerShell' },
    ] }] });
    const result = await importWindowsTerminal({ env, detected });
    expect(result?.keybindings).toEqual([{ keys: 'ctrl+1', command: 'newTabProfileIndex', args: { index: 0 } }]);
    expect(result?.layouts).toEqual([
      { profileId: 'pwsh', startingDirectory: 'C:\\work', title: 'Renamed', panes: [
        { split: 'right', profileId: 'wsl-ubuntu', startingDirectory: '~' }, { split: 'down', commandline: 'cmd.exe' },
      ] }, { profileId: 'pwsh' },
    ]);
  });

  it.each(['preview', 'unpackaged'] as const)('finds %s settings and parses JSONC', async (edition) => {
    const { env, path } = await fixture('\uFEFF{ //comment\n"profiles": [{"name":"cmd", "guid":"{cmd}", "commandline":"cmd.exe",},],}', undefined, edition);
    const result = await importWindowsTerminal({ env, detected: [] });
    expect(result?.sourcePath).toBe(path);
    expect(result?.profiles[0].commandline).toBe('cmd.exe');
  });

  it('returns null when no settings exist and reports malformed settings without throwing', async () => {
    expect(await importWindowsTerminal({ env: {} })).toBeNull();
    const { env } = await fixture('not json');
    expect(await importWindowsTerminal({ env, detected })).toMatchObject({ profiles: [], warnings: ['Windows Terminal settings could not be parsed as JSONC.'] });
    expect(await importWindowsTerminal({ env: { LOCALAPPDATA: join(env.LOCALAPPDATA, 'missing') }, detected })).toBeNull();
  });
});

it.skipIf(process.env.LOOKOUT_LIVE !== '1')('reports real Windows profiles and WT import read-only', async () => {
  vi.setConfig({ testTimeout: 20_000 });
  const { detectProfiles } = await import('./detect');
  const profiles = await detectProfiles();
  const imported = await importWindowsTerminal({ detected: profiles });
  console.log(JSON.stringify({
    detected: profiles.map(({ id, name, shellKind, startupCommand }) => ({ id, name, shellKind, startupCommand })),
    imported: imported && { sourcePath: imported.sourcePath, profiles: imported.profiles.map(({ id, name }) => ({ id, name })), defaultProfileId: imported.defaultProfileId, font: imported.font, keybindings: imported.keybindings, schemes: imported.schemes.length, layouts: imported.layouts.length, warnings: imported.warnings },
  }, null, 2));
  expect(profiles.length).toBeGreaterThan(0);
});
