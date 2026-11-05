import { describe, expect, it } from 'vitest';

import { createDefaultSettings, DEFAULT_WORD_SEPARATORS, normalizeChord, normalizeColor, sanitizeSettings } from './settings-defaults';

describe('createDefaultSettings', () => {
  it('returns WT-like defaults that survive sanitizing unchanged', () => {
    const defaults = createDefaultSettings();
    expect(defaults.defaultProfile).toBe('pwsh');
    expect(defaults.font).toMatchObject({ face: 'Cascadia Mono', size: 13, lineHeight: 1.1, letterSpacing: 0 });
    expect(defaults.colorScheme).toBe('Lookout Night');
    expect(defaults.terminal).toMatchObject({ scrollback: 10_000, cursorStyle: 'bar', cursorBlink: true, rightClick: 'copyPaste', closeOnExit: 'graceful' });
    expect(defaults.terminal.bell).toEqual({ sound: false, visual: true, taskbar: true });
    expect(defaults.window).toMatchObject({ newTabDirectory: 'inherit', restoreSession: true, keepRunningInTray: true, summonHotkey: null });
    expect(defaults.quake).toEqual({ enabled: true, hotkey: 'Super+`', heightPercent: 45 });
    expect(defaults.profiles.map((profile) => profile.id)).toEqual(['pwsh', 'windows-powershell', 'cmd']);
    expect(defaults.profiles[1].commandline).toBe('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(DEFAULT_WORD_SEPARATORS).toContain('\u2502');

    const { settings, warnings } = sanitizeSettings(defaults);
    expect(warnings).toEqual([]);
    expect(settings).toEqual(defaults);
  });

  it('returns independent copies', () => {
    const first = createDefaultSettings();
    first.profiles.push({ id: 'x', name: 'x', commandline: 'x.exe' });
    expect(createDefaultSettings().profiles).toHaveLength(3);
  });
});

describe('sanitizeSettings', () => {
  it('fills missing fields from the base and keeps valid user values', () => {
    const { settings, warnings } = sanitizeSettings({ font: { size: 15 }, terminal: { copyOnSelect: true }, quake: { heightPercent: 60 } });
    expect(warnings).toEqual([]);
    expect(settings.font).toMatchObject({ face: 'Cascadia Mono', size: 15, lineHeight: 1.1 });
    expect(settings.terminal.copyOnSelect).toBe(true);
    expect(settings.terminal.scrollback).toBe(10_000);
    expect(settings.quake.heightPercent).toBe(60);
    expect(settings.version).toBe(2);
  });

  it('clamps out-of-range numbers and rejects wrong types', () => {
    const { settings, warnings } = sanitizeSettings({
      font: { size: 200, lineHeight: 0.5, face: '' },
      terminal: { scrollback: 1e9, cursorStyle: 'beam', warnLargePasteBytes: -5, minimumContrastRatio: 'high', bell: { sound: 'yes' } },
      window: { paneHeaders: 'sometimes', summonHotkey: 42 },
      quake: { heightPercent: 2 },
      notifications: { longCommandSeconds: 0 },
      appTheme: 'neon',
      gitStatus: 1,
    });
    expect(settings.font.size).toBe(72);
    expect(settings.font.lineHeight).toBe(1);
    expect(settings.font.face).toBe('Cascadia Mono');
    expect(settings.terminal.scrollback).toBe(200_000);
    expect(settings.terminal.cursorStyle).toBe('bar');
    expect(settings.terminal.warnLargePasteBytes).toBe(0);
    expect(settings.terminal.minimumContrastRatio).toBe(1);
    expect(settings.terminal.bell.sound).toBe(false);
    expect(settings.window.paneHeaders).toBe('auto');
    expect(settings.window.summonHotkey).toBeNull();
    expect(settings.quake.heightPercent).toBe(10);
    expect(settings.notifications.longCommandSeconds).toBe(1);
    expect(settings.appTheme).toBe('dark');
    expect(settings.gitStatus).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(12);
    expect(warnings.some((warning) => warning.includes('font.size'))).toBe(true);
  });

  it('rounds integer settings', () => {
    expect(sanitizeSettings({ terminal: { scrollback: 1234.6 } }).settings.terminal.scrollback).toBe(1235);
  });

  it('drops invalid profiles, renames duplicate ids and keeps optional fields', () => {
    const { settings, warnings } = sanitizeSettings({
      defaultProfile: 'ubuntu',
      profiles: [
        { id: 'pwsh', name: 'PowerShell', commandline: 'pwsh.exe', font: { face: 'Meslo', size: 'big' }, tabColor: '#ABC', env: { A: '1', B: 2 } },
        { id: 'pwsh', name: 'Another', commandline: 'pwsh.exe -NoLogo' },
        { name: 'Ubuntu', commandline: 'wsl.exe -d Ubuntu', shellKind: 'wsl', hidden: false, cursorStyle: 'block' },
        { id: 'broken', name: 'No command' },
        'nope',
        { commandline: 'x.exe' },
      ],
    });
    expect(settings.profiles.map((profile) => profile.id)).toEqual(['pwsh', 'pwsh-2', 'ubuntu']);
    expect(settings.profiles[0]).toMatchObject({ font: { face: 'Meslo' }, tabColor: '#aabbcc', env: { A: '1' } });
    expect(settings.profiles[2]).toMatchObject({ name: 'Ubuntu', shellKind: 'wsl', cursorStyle: 'block', hidden: false });
    expect(settings.defaultProfile).toBe('ubuntu');
    expect(warnings.some((warning) => warning.includes('duplicate profile id "pwsh"'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('no commandline'))).toBe(true);
    expect(warnings.filter((warning) => warning.includes('removed'))).toHaveLength(3);
  });

  it('guarantees the default profile exists, preferring pwsh then Windows PowerShell', () => {
    const profiles = [
      { id: 'cmd', name: 'Command Prompt', commandline: 'cmd.exe' },
      { id: 'windows-powershell', name: 'Windows PowerShell', commandline: 'powershell.exe' },
    ];
    const missing = sanitizeSettings({ defaultProfile: 'pwsh', profiles });
    expect(missing.settings.defaultProfile).toBe('windows-powershell');
    expect(missing.warnings.some((warning) => warning.includes('defaultProfile'))).toBe(true);

    expect(sanitizeSettings({ defaultProfile: 'Command Prompt', profiles }).settings.defaultProfile).toBe('cmd');
    expect(sanitizeSettings({ defaultProfile: 'CMD', profiles }).settings.defaultProfile).toBe('cmd');
  });

  it('restores fallback profiles when none are usable', () => {
    const { settings, warnings } = sanitizeSettings({ profiles: [{ id: 'x' }], defaultProfile: 'x' });
    expect(settings.profiles.map((profile) => profile.id)).toEqual(['pwsh', 'windows-powershell', 'cmd']);
    expect(settings.defaultProfile).toBe('pwsh');
    expect(warnings.some((warning) => warning.includes('fallback profiles'))).toBe(true);
  });

  it('validates keybindings: canonical chords, known commands, primitive args, last binding wins', () => {
    const { settings, warnings } = sanitizeSettings({
      keybindings: [
        { keys: 'Shift+Ctrl+T', command: 'newTab', args: { profile: 'pwsh', nested: { a: 1 } } },
        { keys: 'ctrl+shift+w', command: null },
        { keys: 'ctrl+k', command: 'launchMissiles' },
        { keys: 'ctrl+alt', command: 'copy' },
        { keys: 'ctrl++', command: 'fontSizeIncrease' },
        { keys: 'win+`', command: 'toggleQuake' },
        { keys: 'ctrl+shift+t', command: 'duplicateTab' },
      ],
    });
    expect(settings.keybindings).toEqual([
      { keys: 'ctrl+shift+w', command: null },
      { keys: 'ctrl+plus', command: 'fontSizeIncrease' },
      { keys: 'meta+`', command: 'toggleQuake' },
      { keys: 'ctrl+shift+t', command: 'duplicateTab' },
    ]);
    expect(warnings.some((warning) => warning.includes('launchMissiles'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('invalid keys'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('"nested"'))).toBe(true);
  });

  it('validates snippets and generates missing ids', () => {
    const { settings, warnings } = sanitizeSettings({
      snippets: [
        { name: 'Git status', command: 'git status', run: true },
        { id: 'git-status', name: 'Dup', command: 'git st' },
        { name: 'Empty', command: '   ' },
      ],
    });
    expect(settings.snippets).toEqual([
      { id: 'git-status', name: 'Git status', command: 'git status', run: true },
      { id: 'git-status-2', name: 'Dup', command: 'git st', run: false },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it('validates color schemes and the selected scheme', () => {
    const colors = Object.fromEntries(['foreground', 'background', 'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'].map((key) => [key, '#123456']));
    const { settings, warnings } = sanitizeSettings({
      colorScheme: 'Mine',
      schemes: [{ name: 'Mine', ...colors, red: '#F00' }, { name: 'Broken', ...colors, blue: 'blue' }],
    });
    expect(settings.schemes).toHaveLength(1);
    expect(settings.schemes[0]).toMatchObject({ name: 'Mine', red: '#ff0000', cursorColor: '#ffffff', selectionBackground: '#ffffff' });
    expect(settings.colorScheme).toBe('Mine');
    expect(warnings).toHaveLength(1);

    const unknown = sanitizeSettings({ colorScheme: 'Nope' });
    expect(unknown.settings.colorScheme).toBe('Lookout Night');
    expect(unknown.warnings[0]).toContain('Nope');
    expect(sanitizeSettings({ colorScheme: 'dracula' }).settings.colorScheme).toBe('dracula');
  });

  it('uses the given base for missing values', () => {
    const base = createDefaultSettings();
    base.font.size = 16;
    base.quake.enabled = false;
    const { settings } = sanitizeSettings({ quake: { hotkey: 'Ctrl+`' } }, base);
    expect(settings.font.size).toBe(16);
    expect(settings.quake).toEqual({ enabled: false, hotkey: 'Ctrl+`', heightPercent: 45 });
  });

  it('never throws on garbage', () => {
    for (const input of [null, undefined, 42, 'x', [], { profiles: 'x', keybindings: {}, terminal: [] }]) {
      expect(() => sanitizeSettings(input)).not.toThrow();
      expect(sanitizeSettings(input).settings.profiles.length).toBeGreaterThan(0);
    }
    const hostile = { get font(): never { throw new Error('boom'); } };
    const result = sanitizeSettings(hostile);
    expect(result.settings.font.face).toBe('Cascadia Mono');
    expect(result.warnings[0]).toContain('boom');
  });
});

describe('helpers', () => {
  it('normalizes chords and colors', () => {
    expect(normalizeChord(' Alt + Shift + Minus ')).toBe('alt+shift+minus');
    expect(normalizeChord('F11')).toBe('f11');
    expect(normalizeChord('ctrl+a+b')).toBeUndefined();
    expect(normalizeColor('#AbC')).toBe('#aabbcc');
    expect(normalizeColor('#11223344')).toBe('#11223344');
    expect(normalizeColor('red')).toBeUndefined();
  });
});
