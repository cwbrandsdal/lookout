// Windows command-line helpers shared by main, pty host and renderer.
// Implements the CommandLineToArgvW / MSVC CRT quoting rules.

import type { ShellKind } from './settings';

export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  let index = 0;

  while (index < commandLine.length) {
    const char = commandLine[index];

    if (char === '\\') {
      let backslashes = 0;
      while (commandLine[index] === '\\') {
        backslashes += 1;
        index += 1;
      }

      if (commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
          index += 1;
        }
      } else {
        current += '\\'.repeat(backslashes);
      }

      hasToken = true;
      continue;
    }

    if (char === '"') {
      // `""` inside a quoted run is a literal quote (CRT behaviour).
      if (inQuotes && commandLine[index + 1] === '"') {
        current += '"';
        index += 2;
        continue;
      }

      inQuotes = !inQuotes;
      hasToken = true;
      index += 1;
      continue;
    }

    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      index += 1;
      continue;
    }

    current += char;
    hasToken = true;
    index += 1;
  }

  if (hasToken) {
    args.push(current);
  }

  return args;
}

export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) {
    return arg;
  }

  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }

    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }

  return `${result}${'\\'.repeat(backslashes * 2)}"`;
}

export function joinCommandLine(args: string[]): string {
  return args.map(quoteArg).join(' ');
}

/** Case-insensitive environment lookup (Windows semantics). */
export function getEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  if (name in env) {
    return env[name];
  }

  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) {
      return env[key];
    }
  }

  return undefined;
}

/** Expands `%VAR%` references and a leading `~`. Unknown variables are left untouched. */
export function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  let expanded = value.replace(/%([^%\s]+)%/g, (match, name: string) => getEnv(env, name) ?? match);

  if (expanded === '~' || expanded.startsWith('~\\') || expanded.startsWith('~/')) {
    const home = getEnv(env, 'USERPROFILE') ?? getEnv(env, 'HOME');
    if (home) {
      expanded = home + expanded.slice(1);
    }
  }

  return expanded;
}

function basename(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).toLowerCase();
}

/** Classifies an executable path/name into a shell kind. */
export function detectShellKind(file: string): ShellKind {
  const name = basename(file).replace(/\.exe$/, '');
  const normalized = file.toLowerCase().replace(/\//g, '\\');

  switch (name) {
    case 'pwsh':
    case 'pwsh-preview':
      return 'pwsh';
    case 'powershell':
      return 'powershell';
    case 'cmd':
      return 'cmd';
    case 'wsl':
    case 'ubuntu':
    case 'debian':
    case 'kali':
      return 'wsl';
    case 'ssh':
      return 'ssh';
    case 'bash':
    case 'sh':
    case 'zsh':
      // C:\Windows\System32\bash.exe is the legacy WSL launcher, not Git Bash.
      return normalized.includes('\\windows\\system32\\') || normalized === 'bash' ? 'wsl' : 'bash';
    default:
      return 'other';
  }
}

/** Kind of the executable at the start of a command line. */
export function detectShellKindFromCommandLine(commandLine: string): ShellKind {
  const [file] = splitCommandLine(commandLine.trim());
  return file ? detectShellKind(file) : 'other';
}
