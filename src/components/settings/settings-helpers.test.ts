import { describe, expect, it } from 'vitest';

import type { KeybindingEntry } from '../../shared/settings';
import { normalizeChord, resolveKeymap } from '../../terminal/keymap';
import { isCommandId } from '../../shared/commands';
import { matchRows } from './catalog';
import { acceleratorParts, acceleratorToChord, captureAccelerator, captureChord, chordParts } from './chords';
import {
  formatEnvText,
  importSchemesFromFile,
  mergeSchemes,
  monoAlternative,
  moveItem,
  parseEnvText,
  parseSshTarget,
  profileFromTemplate,
  stripJsonComments,
  uniqueId,
} from './helpers';
import { addChord, buildVariants, findConflicts, removeChord, resetVariant, variantKey, variantMatches } from './keyboard-model';

function key(init: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; altGraph: boolean }>) {
  const { altGraph = false, ...rest } = init;
  return {
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...rest,
    getModifierState: (name: string) => name === 'AltGraph' && altGraph,
  };
}

const context = { profiles: [{ id: 'pwsh', name: 'PowerShell' }], snippets: [{ id: 'deploy', name: 'Deploy' }], workspaces: [] };

describe('captureChord', () => {
  it('records modified keys in canonical form', () => {
    expect(captureChord(key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'value', value: 'ctrl+shift+t' });
    expect(captureChord(key({ key: '+', code: 'Equal', altKey: true, shiftKey: true }))).toEqual({ kind: 'value', value: 'alt+shift+plus' });
    expect(captureChord(key({ key: 'F5', code: 'F5' }))).toEqual({ kind: 'value', value: 'f5' });
  });

  it('waits on modifier-only presses and cancels on Escape', () => {
    expect(captureChord(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toEqual({ kind: 'pending' });
    expect(captureChord(key({ key: 'Escape', code: 'Escape' }))).toEqual({ kind: 'cancel' });
  });

  it('rejects AltGr and plain typing keys', () => {
    expect(captureChord(key({ key: '{', code: 'Digit7', ctrlKey: true, altKey: true, altGraph: true })).kind).toBe('error');
    expect(captureChord(key({ key: 'a', code: 'KeyA' })).kind).toBe('error');
    expect(captureChord(key({ key: 'A', code: 'KeyA', shiftKey: true })).kind).toBe('error');
    expect(captureChord(key({ key: ' ', code: 'Space' })).kind).toBe('error');
  });

  it('formats chords for display', () => {
    expect(chordParts('ctrl+shift+plus')).toEqual(['Ctrl', 'Shift', '+']);
    expect(chordParts('ctrl+comma')).toEqual(['Ctrl', ',']);
  });
});

describe('captureAccelerator', () => {
  it('produces Electron accelerators from physical keys', () => {
    expect(captureAccelerator(key({ key: '`', code: 'Backquote', metaKey: true }))).toEqual({ kind: 'value', value: 'Super+`' });
    expect(captureAccelerator(key({ key: ' ', code: 'Space', ctrlKey: true, altKey: true }))).toEqual({ kind: 'value', value: 'Ctrl+Alt+Space' });
    // Nordic layout: the key left of 1 reports '§' but is still Backquote.
    expect(captureAccelerator(key({ key: '§', code: 'Backquote', ctrlKey: true }))).toEqual({ kind: 'value', value: 'Ctrl+`' });
    expect(captureAccelerator(key({ key: 'F12', code: 'F12' }))).toEqual({ kind: 'value', value: 'F12' });
  });

  it('requires a modifier other than Shift and rejects AltGr', () => {
    expect(captureAccelerator(key({ key: 'a', code: 'KeyA' })).kind).toBe('error');
    expect(captureAccelerator(key({ key: 'A', code: 'KeyA', shiftKey: true })).kind).toBe('error');
    expect(captureAccelerator(key({ key: '@', code: 'Digit2', ctrlKey: true, altKey: true, altGraph: true })).kind).toBe('error');
    expect(captureAccelerator(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toEqual({ kind: 'pending' });
  });

  it('formats and converts accelerators', () => {
    expect(acceleratorParts('Super+`')).toEqual(['Win', '`']);
    expect(acceleratorParts('CommandOrControl+Shift+Plus')).toEqual(['Ctrl', 'Shift', '+']);
    expect(acceleratorToChord('Super+`')).toBe('win+`');
    expect(acceleratorToChord('Ctrl+Alt+Space')).toBe('ctrl+alt+space');
    expect(acceleratorToChord('Alt+Shift+Plus')).toBe('alt+shift+plus');
  });
});

describe('keyboard model', () => {
  const resolved = (user: KeybindingEntry[]) => resolveKeymap(user, isCommandId);

  it('builds variants with defaults and per-arg rows', () => {
    const variants = buildVariants([], context);
    const newTab = variants.find((variant) => variant.key === variantKey('newTab'));
    expect(newTab?.chords).toContain('ctrl+shift+t');
    expect(newTab?.modified).toBe(false);
    expect(variants.find((variant) => variant.key === variantKey('switchToTab', { index: -1 }))?.title).toBe('Switch to last tab');
    expect(variants.find((variant) => variant.key === variantKey('newTabProfileIndex', { index: 0 }))?.title).toBe('New tab with profile 1 (PowerShell)');
    expect(variants.find((variant) => variant.key === variantKey('runSnippet', { id: 'deploy' }))?.title).toBe('Run snippet: Deploy');
    // Arg-only commands have no bare row.
    expect(variants.some((variant) => variant.key === variantKey('switchToTab'))).toBe(false);
  });

  it('adds, removes and resets chords', () => {
    let user = addChord([], 'ctrl+alt+t', 'newTab');
    expect(resolved(user).get('ctrl+alt+t')?.command).toBe('newTab');

    user = removeChord(user, 'ctrl+shift+t');
    expect(resolved(user).has('ctrl+shift+t')).toBe(false);
    expect(user).toContainEqual({ keys: 'ctrl+shift+t', command: null });

    const variant = buildVariants(user, context).find((entry) => entry.key === variantKey('newTab'));
    expect(variant?.modified).toBe(true);

    user = resetVariant(user, 'newTab');
    expect(user).toEqual([]);
  });

  it('re-adding a default chord just drops the override', () => {
    const user = addChord(removeChord([], 'ctrl+shift+t'), 'Ctrl+Shift+T', 'newTab');
    expect(user).toEqual([]);
  });

  it('removing a user chord that replaced a default keeps the chord unbound', () => {
    const user = removeChord(addChord([], 'ctrl+shift+d', 'newWindow'), 'ctrl+shift+d');
    expect(resolved(user).has('ctrl+shift+d')).toBe(false);
  });

  it('reports overridden defaults and global hotkey clashes', () => {
    const user = addChord([], 'ctrl+shift+d', 'newWindow');
    const variants = buildVariants(user, context);
    const conflicts = findConflicts(user, variants, [{ chord: normalizeChord('ctrl+shift+t'), label: 'summon hotkey' }]);
    expect(conflicts.find((conflict) => conflict.variantKey === variantKey('newWindow'))?.message).toMatch(/Duplicate tab/);
    expect(conflicts.find((conflict) => conflict.variantKey === variantKey('duplicateTab'))?.message).toMatch(/New window/);
    expect(conflicts.find((conflict) => conflict.variantKey === variantKey('newTab'))?.message).toMatch(/summon hotkey/);
  });

  it('searches titles and chords', () => {
    const variants = buildVariants([], context);
    const newTab = variants.find((variant) => variant.key === variantKey('newTab'))!;
    expect(variantMatches(newTab, 'ctrl+shift+t')).toBe(true);
    expect(variantMatches(newTab, 'tabs new')).toBe(true);
    expect(variantMatches(newTab, 'paste')).toBe(false);
  });
});

describe('helpers', () => {
  it('parses and formats env text', () => {
    const { env, errors } = parseEnvText('# comment\nFOO=bar\n\nPATH_EXTRA = C:\\tools=x \nbroken\n=nokey\nA B=1');
    expect(env).toEqual({ FOO: 'bar', PATH_EXTRA: 'C:\\tools=x' });
    expect(errors).toHaveLength(3);
    expect(formatEnvText({ A: '1', B: 'two' })).toBe('A=1\nB=two');
  });

  it('builds unique ids and moves items', () => {
    expect(uniqueId('pwsh', ['PWSH', 'pwsh-2'])).toBe('pwsh-3');
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('creates profiles from templates', () => {
    const ssh = profileFromTemplate('ssh', 'alex@devbox:2222', []);
    expect(ssh).toEqual({ profile: expect.objectContaining({ id: 'ssh-devbox', name: 'devbox', commandline: 'ssh.exe alex@devbox -p 2222', source: 'user' }) });
    expect('error' in profileFromTemplate('ssh', 'two words', [])).toBe(true);
    expect(profileFromTemplate('wsl', 'Ubuntu-22.04', ['wsl-ubuntu-22-04'])).toEqual({
      profile: expect.objectContaining({ id: 'wsl-ubuntu-22-04-2', commandline: 'wsl.exe -d Ubuntu-22.04' }),
    });
    expect(parseSshTarget('host')).toEqual({ target: 'host', host: 'host', port: undefined });
  });

  it('imports WT JSON with comments and merges by name', () => {
    const text = `{
      // my settings
      "schemes": [{ "name": "Mine", "foreground": "#ffffff", "background": "#000000",
        "black": "#000000", "red": "#ff0000", "green": "#00ff00", "yellow": "#ffff00", "blue": "#0000ff",
        "purple": "#ff00ff", "cyan": "#00ffff", "white": "#ffffff", "brightBlack": "#111111", "brightRed": "#ff1111",
        "brightGreen": "#11ff11", "brightYellow": "#ffff11", "brightBlue": "#1111ff", "brightPurple": "#ff11ff",
        "brightCyan": "#11ffff", "brightWhite": "#fefefe", },],
    }`;
    const schemes = importSchemesFromFile('settings.json', text);
    expect(schemes.map((scheme) => scheme.name)).toEqual(['Mine']);
    expect(mergeSchemes([{ ...schemes[0], name: 'mine', red: '#123456' }], schemes)).toEqual(schemes);
    expect(() => importSchemesFromFile('bad.json', '{')).toThrow(/not valid JSON/);
    expect(stripJsonComments('{"a": "x//y", /* c */ "b": 1,}')).toBe('{"a": "x//y",  "b": 1}');
  });

  it('suggests fixed-width Nerd Font siblings', () => {
    expect(monoAlternative('JetBrainsMono Nerd Font Propo', ['JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono'])).toBe('JetBrainsMono Nerd Font Mono');
    expect(monoAlternative('Cascadia Mono', ['Cascadia Mono'])).toBeNull();
  });

  it('searches setting labels and keywords', () => {
    expect(matchRows('scrollback').has('terminal.scrollback')).toBe(true);
    expect(matchRows('quake').has('general.quakeHotkey')).toBe(true);
    expect(matchRows('')).toEqual(new Set());
  });
});
