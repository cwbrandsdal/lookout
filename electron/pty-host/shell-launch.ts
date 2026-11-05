// Injection approach adapted from VS Code terminalEnvironment.ts (Microsoft Corporation, MIT).
import { randomBytes } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  detectShellKind,
  expandEnvVars,
  getEnv,
  joinCommandLine,
  splitCommandLine,
} from '../../src/shared/commandline';
import type { ShellLaunch, ShellLaunchInput } from '../../src/shared/pty';

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Store AppExecLink aliases cannot be followed by Node's stat, but Windows
    // CreateProcess can execute them. This includes the Store pwsh.exe alias.
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/** Resolve against the launch environment, without starting where.exe on every spawn. */
function resolveExecutable(file: string, input: ShellLaunchInput): string {
  const extensions = path.extname(file) ? [''] : ['', ...(getEnv(input.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')];
  const directories = /[\\/]/.test(file) || path.isAbsolute(file)
    ? ['']
    : [input.cwd, ...(getEnv(input.env, 'PATH') ?? '').split(path.delimiter)];
  for (const directory of directories) {
    const candidate = path.resolve(input.cwd, directory.replace(/^"|"$/g, ''), file);
    for (const extension of extensions) {
      if (isFile(candidate + extension)) {
        return candidate + extension;
      }
    }
  }
  return file;
}

function setEnv(env: Record<string, string>, name: string, value?: string): void {
  // node-pty receives an ordinary object; eliminate Windows case-insensitive duplicates.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete env[key];
    }
  }
  if (value !== undefined) {
    env[name] = value;
  }
}

function hasPowerShellCommand(args: string[]): boolean {
  return args.some((arg) => {
    const name = arg.replace(/^[-/]/, '').toLowerCase();
    if (!/^[-/]/.test(arg) || !name) {
      return false;
    }
    // PowerShell accepts unambiguous prefixes as well as the special -ec alias.
    // -e is also treated conservatively: it is ambiguous with ExecutionPolicy in some versions.
    return ['command', 'commandwithargs', 'file', 'encodedcommand'].some((option) => option.startsWith(name))
      || name === 'ec' || name === 'cwa';
  });
}

function bashPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/** Build raw argv: node-pty's Windows argsToCommandLine performs the CRT quoting itself. */
export function buildShellLaunch(input: ShellLaunchInput): ShellLaunch {
  const [executable, ...args] = splitCommandLine(expandEnvVars(input.commandline.trim(), input.env));
  if (!executable) {
    throw new Error('A shell executable is required');
  }
  const file = resolveExecutable(executable, input);
  const shellKind = detectShellKind(file);
  const env = { ...input.env };
  setEnv(env, 'TERM', 'xterm-256color');
  setEnv(env, 'COLORTERM', 'truecolor');
  setEnv(env, 'TERM_PROGRAM', 'Lookout');
  setEnv(env, 'LOOKOUT_NONCE', randomBytes(16).toString('hex'));
  setEnv(env, 'LOOKOUT_SHELL_INTEGRATION');
  setEnv(env, 'LOOKOUT_SHELL_LOGIN');
  setEnv(env, 'LOOKOUT_STARTUP_COMMAND');
  let integrated = false;

  if (shellKind === 'pwsh' || shellKind === 'powershell') {
    if (!hasPowerShellCommand(args)) {
      if (input.shellIntegration) {
        const script = path.join(input.shellIntegrationDir, 'lookout.ps1').replace(/'/g, "''");
        // UTF-16LE -EncodedCommand avoids two parsers' quoting of spaces, apostrophes,
        // and embedded quotes in paths. Profiles still load before this command.
        const command = `try { . '${script}' } catch {}`;
        args.push('-NoExit', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'));
        integrated = true;
        if (input.startupCommand) {
          setEnv(env, 'LOOKOUT_STARTUP_COMMAND', input.startupCommand);
        }
      } else if (input.startupCommand) {
        args.push('-NoExit', '-EncodedCommand', Buffer.from(input.startupCommand, 'utf16le').toString('base64'));
      }
    }
    // Existing -Command/-File/-EncodedCommand owns execution. Appending another command
    // or changing its source changes user semantics, so a startup command is dropped.
  } else if (shellKind === 'cmd') {
    if (input.shellIntegration) {
      const prompt = getEnv(env, 'PROMPT') ?? '$P$G';
      // CMD PROMPT supports $e (ESC), but not BEL: consistently use ST ($e\).
      setEnv(env, 'PROMPT', `$e]633;D$e\\$e]633;A$e\\$e]633;P;Cwd=$P$e\\${prompt}$e]633;B$e\\`);
      integrated = true;
    }
    if (input.startupCommand && !args.some((arg) => /^\/[ck]/i.test(arg))) {
      // Expand through CMD itself so node-pty cannot backslash-escape embedded CMD
      // quotes. CALL also expands %variables% inside the startup source.
      setEnv(env, 'LOOKOUT_STARTUP_COMMAND', input.startupCommand);
      args.push('/k', 'call', '%LOOKOUT_STARTUP_COMMAND%');
    }
  } else if (shellKind === 'bash' && /^bash(?:\.exe)?$/i.test(path.win32.basename(file))) {
    // --init-file is ignored for -c/scripts; never silently change those launches.
    const hasCommand = args.some((arg) => /^-[^-]*c/.test(arg) || arg === '--command');
    const hasScript = args.some((arg) => !arg.startsWith('-'));
    if (input.shellIntegration && !hasCommand && !hasScript) {
      const bashArgs: string[] = [];
      for (const arg of args) {
        if (arg === '--login' || /^-[il]+$/.test(arg) && arg.includes('l')) {
          setEnv(env, 'LOOKOUT_SHELL_LOGIN', '1');
          if (arg !== '--login' && arg.includes('i')) {
            bashArgs.push('-i');
          }
        } else {
          bashArgs.push(arg);
        }
      }
      // Bash requires long options before short options. Keep -i (and other user flags).
      args.splice(0, args.length, '--init-file', bashPath(path.join(input.shellIntegrationDir, 'lookout.bash')), ...bashArgs);
      integrated = true;
      if (input.startupCommand) {
        setEnv(env, 'LOOKOUT_STARTUP_COMMAND', input.startupCommand);
      }
    }
  }
  // WSL, SSH and unknown interpreters have incompatible remote/argument semantics;
  // do not append startup source or forward the integration startup variable to them.
  // joinCommandLine is for display/round trips only, never pre-quote the returned argv.
  // Validate the composed Windows command line without pre-quoting the returned argv.
  if (joinCommandLine([file, ...args]).includes('\0')) {
    throw new Error('Shell command line contains a NUL character');
  }
  if (integrated) {
    setEnv(env, 'LOOKOUT_SHELL_INTEGRATION', '1');
  }
  return { file, args, env, shellKind, integrated };
}
