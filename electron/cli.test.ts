import { beforeEach, describe, expect, it, vi } from 'vitest';
import { statSync } from 'node:fs';
import { adminLaunchArgs, CLI_HELP_TEXT, parseCliArgs, stripElectronArgs } from './cli';
import { splitCommandLine } from '../src/shared/commandline';

vi.mock('node:fs', () => ({ statSync: vi.fn() }));

const cwd = 'C:\\Work';
const parse = (args: string[]) => parseCliArgs(args, cwd);

beforeEach(() => {
  vi.mocked(statSync).mockReset();
  vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT'); });
});

describe('parseCliArgs', () => {
  it('opens the caller directory by default', () => {
    expect(parse([])).toEqual({
      window: 'last', elevated: false, help: false, version: false, errors: [],
      actions: [{ type: 'new-tab', startingDirectory: cwd }],
    });
    expect(parse(['.']).actions).toEqual([{ type: 'new-tab', startingDirectory: cwd }]);
  });

  it('recognizes existing relative and absolute directories, but not existing files', () => {
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    expect(parse(['repo']).actions).toEqual([{ type: 'new-tab', startingDirectory: 'C:\\Work\\repo' }]);
    expect(parse(['D:\\Other Folder']).actions).toEqual([{ type: 'new-tab', startingDirectory: 'D:\\Other Folder' }]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);
    expect(parse(['file.exe']).actions).toEqual([{ type: 'new-tab', commandline: 'file.exe' }]);
  });

  it.each(['new-tab', 'nt'])('parses %s options and resolves directories', (command) => {
    expect(parse([command, '-p', 'PowerShell', '-d', '..\\Repo', '--title', 'Build output', '--tabColor', '#123abc']).actions).toEqual([
      { type: 'new-tab', profile: 'PowerShell', startingDirectory: 'C:\\Repo', title: 'Build output', tabColor: '#123abc' },
    ]);
    expect(parse([command, '--profile', '{profile-id}', '--startingDirectory', '.']).actions[0]).toMatchObject({
      profile: '{profile-id}', startingDirectory: cwd,
    });
  });

  it('accepts implicit new-tab options', () => {
    expect(parse(['-d', '.', '-p', 'pwsh']).actions).toEqual([{ type: 'new-tab', startingDirectory: cwd, profile: 'pwsh' }]);
  });

  it('keeps command arguments and their Windows quoting', () => {
    const command = ['pwsh', '-NoExit', '-Command', 'Write-Host "hello world"', '', 'C:\\Space Here\\'];
    const action = parse(['nt', ...command]).actions[0];
    expect(action.type).toBe('new-tab');
    if (action.type !== 'new-tab') throw new Error('Expected new-tab');
    expect(splitCommandLine(action.commandline!)).toEqual(command);
    expect(parse(['pwsh', '--title', 'shell option']).actions).toEqual([{ type: 'new-tab', commandline: 'pwsh --title "shell option"' }]);
    expect(parse(['nt', '--', '--version', '-x']).actions).toEqual([{ type: 'new-tab', commandline: '--version -x' }]);
  });

  it('parses standalone and attached separators', () => {
    expect(parse(['nt', '-p', 'pwsh;', 'sp', '-H', ';', 'ft', '-t', '2;', 'settings']).actions).toEqual([
      { type: 'new-tab', profile: 'pwsh' }, { type: 'split-pane', direction: 'down' },
      { type: 'focus-tab', index: 2 }, { type: 'settings' },
    ]);
    expect(parse([';', 'nt', ';;', 'quake', ';']).actions).toEqual([{ type: 'new-tab' }, { type: 'quake' }]);
    expect(parse(['nt', 'pwsh', '-Command', 'a;b']).actions).toEqual([{ type: 'new-tab', commandline: 'pwsh -Command a;b' }]);
  });

  it.each([
    ['-H', 'down'], ['--horizontal', 'down'], ['-V', 'right'], ['--vertical', 'right'],
  ])('maps %s to %s', (option, direction) => {
    expect(parse(['sp', option]).actions).toEqual([{ type: 'split-pane', direction }]);
  });

  it('parses split options and leaves direction automatic by default', () => {
    expect(parse(['split-pane', '--size', '0.4', '--profile', 'wsl', '--startingDirectory', '.', '--title', 'Linux', 'bash', '-l']).actions).toEqual([
      { type: 'split-pane', direction: 'auto', size: 0.4, profile: 'wsl', startingDirectory: cwd, title: 'Linux', commandline: 'bash -l' },
    ]);
    expect(parse(['sp', '-s', '.25']).actions[0]).toMatchObject({ size: 0.25 });
  });

  it.each(['0', '1'])('accepts split size boundary %s', (value) => {
    expect(parse(['sp', '-s', value])).toMatchObject({ errors: [], actions: [{ type: 'split-pane', direction: 'auto', size: Number(value) }] });
  });

  it.each(['-0.1', '1.1', 'NaN', 'Infinity', ''])('reports invalid split size %j', (value) => {
    expect(parse(['sp', '-s', value]).errors).toContain('Split size must be between 0 and 1.');
  });

  it('reports conflicting split directions', () => {
    expect(parse(['sp', '-H', '-V']).errors).toContain('Choose either horizontal or vertical splitting.');
  });

  it.each(['0', '12'])('focuses zero-based tab %s', (index) => {
    expect(parse(['focus-tab', '--target', index]).actions).toEqual([{ type: 'focus-tab', index: Number(index) }]);
  });

  it.each(['-1', '1.5', 'abc', '', '9007199254740992'])('rejects invalid tab index %j', (index) => {
    const result = parse(['ft', '-t', index]);
    expect(result.actions).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('parses workspace and simple actions', () => {
    expect(parse(['open', 'My workspace', ';', 'settings', ';', 'quake', ';', 'admin']).actions).toEqual([
      { type: 'open-workspace', name: 'My workspace' }, { type: 'settings' }, { type: 'quake' }, { type: 'admin-window' },
    ]);
  });

  it.each(['last', 'new', 'my-window', '42', '0'])('selects window %s', (window) => {
    expect(parse(['-w', window, 'nt']).window).toBe(window === '0' ? 'last' : window);
    expect(parse(['nt', '--window', window]).window).toBe(window === '0' ? 'last' : window);
  });

  it('supports help/version/elevation without mistaking child flags for globals', () => {
    expect(parse(['--help'])).toMatchObject({ help: true, actions: [] });
    expect(parse(['-v'])).toMatchObject({ version: true, actions: [] });
    expect(parse(['--elevated', '--window', 'new'])).toMatchObject({ elevated: true, window: 'new', actions: [{ type: 'new-tab', startingDirectory: cwd }] });
    expect(parse(['nt', 'pwsh', '--version'])).toMatchObject({ version: false, actions: [{ type: 'new-tab', commandline: 'pwsh --version' }] });
  });

  it('collects errors across commands without throwing', () => {
    const result = parse(['nt', '-p', ';', 'ft', ';', 'open', ';', 'settings', 'extra', ';', 'sp', '--bogus', '-d']);
    expect(result.errors).toEqual(expect.arrayContaining([
      'Missing value for -p.', 'focus-tab requires -t/--target <index>.',
      'open requires a workspace name.', 'Unexpected argument for settings: extra',
      'Unknown option: --bogus', 'Missing value for -d.',
    ]));
    expect(parse(['-d', '--title', 'Still parsed']).actions[0]).toMatchObject({ title: 'Still parsed' });
  });

  it('documents the supported commands and separator escaping', () => {
    for (const word of ['new-tab', 'split-pane', 'focus-tab', 'open <workspace>', 'settings', 'quake', 'admin', '--window', '--elevated', 'PowerShell']) {
      expect(CLI_HELP_TEXT).toContain(word);
    }
  });
});

describe('adminLaunchArgs', () => {
  it('carries the first workspace or new tab into the administrator window', () => {
    expect(adminLaunchArgs([])).toEqual([]);
    expect(adminLaunchArgs([{ type: 'focus-tab', index: 1 }])).toEqual([]);
    expect(adminLaunchArgs([{ type: 'open-workspace', nameOrId: 'Infra tools' }])).toEqual(['open', 'Infra tools']);
    expect(parse(adminLaunchArgs([{ type: 'open-workspace', nameOrId: 'Infra tools' }])).actions).toEqual([{ type: 'open-workspace', name: 'Infra tools' }]);
    expect(parse(adminLaunchArgs([{ type: 'focus-tab', index: 1 }, { type: 'new-tab', profileId: 'pwsh', cwd: 'D:\\My Projects' }])).actions).toEqual([
      { type: 'new-tab', profile: 'pwsh', startingDirectory: 'D:\\My Projects' },
    ]);
  });
});

describe('stripElectronArgs', () => {
  it('removes the executable and dev app path only in development', () => {
    expect(stripElectronArgs(['electron.exe', 'D:\\Lookout', '-d', '.'], { isPackaged: false })).toEqual(['-d', '.']);
    expect(stripElectronArgs(['Lookout.exe', 'pwsh', '-NoExit'], { isPackaged: true })).toEqual(['pwsh', '-NoExit']);
    expect(stripElectronArgs([], { isPackaged: false })).toEqual([]);
  });

  it('removes Chromium switches before and after the dev app path', () => {
    expect(stripElectronArgs([
      'electron.exe', '--inspect=9229', 'D:\\Lookout', '--allow-file-access-from-files',
      '--original-process-start-time=123456', '--enable-features=FeatureA,FeatureB',
      '--remote-debugging-port=0', '--disable-features', 'FeatureC', '--window', 'new', '--elevated', '-d', '.',
    ], { isPackaged: false })).toEqual(['--window', 'new', '--elevated', '-d', '.']);
  });

  it('preserves Lookout flags and commandline options with Electron-like names', () => {
    expect(stripElectronArgs(['Lookout.exe', '--help', '--version', '--elevated', 'nt', '--title', '--inspect', 'node', '--inspect'], { isPackaged: true })).toEqual([
      '--help', '--version', '--elevated', 'nt', '--title', '--inspect', 'node', '--inspect',
    ]);
    expect(stripElectronArgs(['Lookout.exe', 'nt', '--', 'node', '--remote-debugging-port=1'], { isPackaged: true })).toEqual([
      'nt', '--', 'node', '--remote-debugging-port=1',
    ]);
  });

  it('does not consume a shell name after a valueless inspector switch', () => {
    expect(stripElectronArgs(['Lookout.exe', '--inspect', 'pwsh'], { isPackaged: true })).toEqual(['pwsh']);
    expect(stripElectronArgs(['Lookout.exe', '--inspect-brk', 'localhost:9229', 'pwsh'], { isPackaged: true })).toEqual(['pwsh']);
    expect(stripElectronArgs(['electron.exe', '--enable-features', 'FeatureA', 'D:\\Lookout', 'nt'], { isPackaged: false })).toEqual(['nt']);
  });
});
