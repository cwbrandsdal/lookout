import { describe, expect, it } from 'vitest';
import { buildRegistrationCommands, buildRestoreCommands, PROXY_CLSID, quoteWindowsArgument, TERMINAL_CLSID } from './default-terminal';

describe('default-terminal registration planning', () => {
  it('quotes Windows arguments including embedded quotes and trailing backslashes', () => {
    expect(quoteWindowsArgument('C:\\Program Files\\Lookout\\')).toBe('"C:\\Program Files\\Lookout\\\\"');
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
    expect(() => quoteWindowsArgument('a\0b')).toThrow();
  });

  it('restores absent values by deletion and preserves existing registry value types', () => {
    expect(buildRestoreCommands({ DelegationConsole: null, DelegationTerminal: { type: 'REG_EXPAND_SZ', data: '%previous%' } })).toEqual([
      ['delete', 'HKCU\\Console\\%%Startup', '/v', 'DelegationConsole', '/f', '/reg:64'],
      ['add', 'HKCU\\Console\\%%Startup', '/v', 'DelegationTerminal', '/t', 'REG_EXPAND_SZ', '/d', '%previous%', '/f', '/reg:64'],
    ]);
  });

  it('keeps exact string content and multi-string separators in restore arguments', () => {
    const commands = buildRestoreCommands({
      DelegationConsole: { type: 'REG_SZ', data: '  previous\nvalue  ' },
      DelegationTerminal: { type: 'REG_MULTI_SZ', data: 'first\x01second', separator: '\x01' },
    });
    expect(commands[0]).toContain('  previous\nvalue  ');
    expect(commands[1].slice(-4)).toEqual(['/s', '\x01', '/f', '/reg:64']);
  });

  it('writes only unique Lookout CLSIDs and config, never Microsoft interface or class registrations', () => {
    const commands = buildRegistrationCommands({ exePath: 'C:\\Lookout\\Lookout.exe', userDataDir: 'C:\\data', nativeDir: 'C:\\Lookout\\native', isPackaged: true });
    for (const command of commands) {
      expect(command[1]).toMatch(new RegExp(`^HKCU\\\\Software\\\\(?:Lookout\\\\Handoff|Classes\\\\CLSID\\\\(?:${TERMINAL_CLSID}|${PROXY_CLSID}))`));
      expect(command.join(' ')).not.toContain('Interface\\');
    }
    expect(commands[0][commands[0].indexOf('/d') + 1]).toBe('"C:\\Lookout\\native\\LookoutHandoff.exe" -Embedding');
    expect(commands.find((command) => command.includes('LaunchArguments'))).toContain('');
  });

  it('starts Electron development mode with the repository as an argument', () => {
    const commands = buildRegistrationCommands({ exePath: 'D:\\repo\\node_modules\\electron\\dist\\electron.exe', userDataDir: 'C:\\data', nativeDir: 'D:\\repo\\native\\handoff\\bin', isPackaged: false });
    expect(commands.find((command) => command.includes('LaunchArguments'))).toContain('"D:\\repo"');
  });
});
