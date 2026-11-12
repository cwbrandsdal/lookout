// A fresh environment block for new sessions, built the way Windows Terminal
// does it: re-read the system and user environment from the registry so new
// tabs see PATH (and other) changes made after Lookout started.

import { execFile } from 'node:child_process';
import path from 'node:path';

export type Environment = Record<string, string>;
export type EnvironmentLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export const SYSTEM_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const USER_ENVIRONMENT_KEY = 'HKCU\\Environment';

/**
 * Variables that belong to the logon session (`HKCU\Volatile Environment` and
 * the token), which Windows applies after both registry hives. The system hive
 * even holds `USERNAME=SYSTEM`, meant for services, so taking these from the
 * registry would mislabel the user; they always keep the process's values.
 */
const LOGON_VARIABLES = new Set([
  'username',
  'userdomain',
  'userdomain_roamingprofile',
  'userdnsdomain',
  'userprofile',
  'homedrive',
  'homepath',
  'homeshare',
  'logonserver',
  'appdata',
  'localappdata',
  'clientname',
  'sessionname',
]);

const DEFAULT_TTL_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 1_500;
const REG_TIMEOUT_MS = 5_000;

export interface RegistryValue {
  name: string;
  type: 'REG_SZ' | 'REG_EXPAND_SZ';
  value: string;
}

// `    Name    REG_TYPE    value` (the value part is absent for empty strings).
// `s`: a value that contained CRLF ends its first line with a stray CR.
const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/s;

/**
 * Parses `reg.exe query <key>` output. Only string values are environment variables.
 *
 * reg.exe prints line breaks inside a value as-is (an LF as CRLF), so a value
 * can span several lines; e.g. an installer that appended "\n  C:\tools" to
 * the user Path. Lines that are not a new value continue the previous one, so
 * the value arrives whole, as Windows Terminal (which reads the registry
 * directly) sees it, instead of losing everything after the break.
 */
export function parseRegQuery(output: string): RegistryValue[] {
  const values: RegistryValue[] = [];
  let last: RegistryValue | null = null;
  let blankLines = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = VALUE_LINE.exec(line);
    if (match) {
      const [, name, type, value = ''] = match;
      // `(Default)` (localized) is the key's unnamed value, not a variable.
      last = (type === 'REG_SZ' || type === 'REG_EXPAND_SZ') && !/^\(.*\)$/.test(name) ? { name, type, value } : null;
      if (last) {
        values.push(last);
      }
    } else if (line === '') {
      // A blank line inside a value, or the end of the values.
      blankLines += 1;
      continue;
    } else if (last && !line.startsWith('HKEY_')) {
      last.value += '\n'.repeat(blankLines + 1) + line;
    } else {
      // The key header, or the subkey list after the values.
      last = null;
    }
    blankLines = 0;
  }
  return values;
}

/** Case-insensitive environment builder that keeps the casing of the first key it saw. */
class EnvironmentBuilder {
  readonly env: Environment = {};
  private readonly keys = new Map<string, string>();

  constructor(base: Record<string, string | undefined>) {
    for (const [name, value] of Object.entries(base)) {
      if (typeof value === 'string') {
        this.set(name, value);
      }
    }
  }

  get(name: string): string | undefined {
    const key = this.keys.get(name.toLowerCase());
    return key === undefined ? undefined : this.env[key];
  }

  set(name: string, value: string): void {
    const lower = name.toLowerCase();
    const existing = this.keys.get(lower);
    if (existing === undefined) {
      this.keys.set(lower, name);
      this.env[name] = value;
    } else {
      this.env[existing] = value;
    }
  }
}

/** ExpandEnvironmentStrings semantics: unknown `%VAR%` references stay as typed. */
export function expandRegistryValue(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(/%([^%=\r\n]+)%/g, (match, name: string) => lookup(name) ?? match);
}

function joinPathLists(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return first.endsWith(';') ? first + second : `${first};${second}`;
}

/**
 * Overlays the system then user registry environment on `base` (normally
 * `process.env`). Keys match case-insensitively and keep `base`'s casing.
 * PATH is system Path + user Path, as Windows builds it at logon. Logon
 * variables such as USERNAME are never taken from the registry.
 */
export function mergeEnvironment(
  base: Record<string, string | undefined>,
  system: readonly RegistryValue[],
  user: readonly RegistryValue[],
): Environment {
  const builder = new EnvironmentBuilder(base);
  const lookup = (name: string) => builder.get(name);
  const paths: Array<string | undefined> = [undefined, undefined];

  [system, user].forEach((values, hive) => {
    // Plain strings first, so expandable values can reference any of them.
    for (const pass of ['REG_SZ', 'REG_EXPAND_SZ'] as const) {
      for (const entry of values) {
        if (entry.type !== pass || LOGON_VARIABLES.has(entry.name.toLowerCase())) {
          continue;
        }
        const value = pass === 'REG_EXPAND_SZ' ? expandRegistryValue(entry.value, lookup) : entry.value;
        if (entry.name.toLowerCase() === 'path') {
          paths[hive] = value;
          if (hive === 0) {
            builder.set(entry.name, value);
          }
        } else {
          builder.set(entry.name, value);
        }
      }
    }
  });

  const combined = joinPathLists(paths[0], paths[1]);
  if (combined !== undefined) {
    builder.set('Path', combined);
  }
  return builder.env;
}

function systemExecutable(name: string): string {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name);
}

/**
 * `reg.exe query <key>`, decoded losslessly. reg.exe converts its output to
 * the console's OEM code page when writing to a pipe, which turns e.g. `ø`
 * into `o`; switching the (hidden, private) console to UTF-8 first avoids that.
 */
export function queryRegistryKey(key: string, timeoutMs = REG_TIMEOUT_MS): Promise<string> {
  if (!/^[A-Za-z0-9_ \\]+$/.test(key)) {
    return Promise.reject(new Error(`Refusing to query unexpected registry key ${key}`));
  }
  const commandLine = `/d /s /c "chcp 65001 >nul & "${systemExecutable('reg.exe')}" query "${key}""`;
  return new Promise((resolve, reject) => {
    execFile(
      systemExecutable('cmd.exe'),
      [commandLine],
      {
        windowsHide: true,
        windowsVerbatimArguments: true,
        encoding: 'buffer',
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.toString('utf8'));
        }
      },
    );
  });
}

function processEnvironment(): Record<string, string | undefined> {
  return { ...process.env };
}

function copyDefined(env: Record<string, string | undefined>): Environment {
  const copy: Environment = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      copy[name] = value;
    }
  }
  return copy;
}

export interface FreshEnvironmentOptions {
  /** How long a read counts as fresh, so a burst of spawns (restoring a window) shares one read. */
  ttlMs?: number;
  /** How long a spawn may wait for a registry read before it falls back to the last good environment. */
  readTimeoutMs?: number;
  /** Returns `reg.exe query` output for a key (injectable for tests). */
  query?: (key: string) => Promise<string>;
  /** Base environment the registry values are overlaid on. Defaults to `process.env`. */
  baseEnvironment?: () => Record<string, string | undefined>;
  log?: EnvironmentLog;
  now?: () => number;
}

/**
 * The environment for a new session. Like Windows Terminal, every spawn gets
 * a fresh read of the registry (unless one finished within `ttlMs`), so a tab
 * opened right after an install sees the new PATH. The wait is bounded by
 * `readTimeoutMs`; a failed or slow read falls back to the last good
 * environment (or the process environment), and spawns arriving while that
 * slow read is still running do not wait on it again.
 */
export class FreshEnvironment {
  private cache: { env: Environment; at: number } | null = null;
  private inflight: Promise<Environment | null> | null = null;
  /** `inflight` raced against `readTimeoutMs`, shared by every spawn waiting on that read. */
  private bounded: Promise<Environment | null> | null = null;
  private readonly ttlMs: number;
  private readonly readTimeoutMs: number;
  private readonly query: (key: string) => Promise<string>;
  private readonly baseEnvironment: () => Record<string, string | undefined>;
  private readonly log: EnvironmentLog;
  private readonly now: () => number;

  constructor(options: FreshEnvironmentOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.query = options.query ?? ((key) => queryRegistryKey(key));
    this.baseEnvironment = options.baseEnvironment ?? processEnvironment;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /** Starts the initial read early so the first spawn rarely waits. */
  prime(): void {
    void this.refresh();
  }

  async get(): Promise<Environment> {
    if (this.cache && this.now() - this.cache.at <= this.ttlMs) {
      return { ...this.cache.env };
    }
    const env = await this.readBounded();
    if (env) {
      return { ...env };
    }
    return this.cache ? { ...this.cache.env } : copyDefined(this.baseEnvironment());
  }

  private readBounded(): Promise<Environment | null> {
    if (!this.bounded) {
      const read = this.refresh();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          this.log('warn', `Reading the system environment took over ${this.readTimeoutMs} ms; using the last known environment`);
          resolve(null);
        }, this.readTimeoutMs);
      });
      const bounded = Promise.race([read, timeout]);
      this.bounded = bounded;
      void read.then(() => {
        clearTimeout(timer);
        if (this.bounded === bounded) {
          this.bounded = null;
        }
      });
    }
    return this.bounded;
  }

  private refresh(): Promise<Environment | null> {
    if (!this.inflight) {
      this.inflight = this.read()
        .then((env) => {
          this.cache = { env, at: this.now() };
          return env;
        }, (error: unknown) => {
          this.log('warn', `Could not read the system environment: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async read(): Promise<Environment> {
    const [systemOutput, userOutput] = await Promise.all([
      this.query(SYSTEM_ENVIRONMENT_KEY),
      // A missing user environment key is unusual but valid.
      this.query(USER_ENVIRONMENT_KEY).catch((error: unknown) => {
        this.log('warn', `Could not read the user environment: ${error instanceof Error ? error.message : String(error)}`);
        return '';
      }),
    ]);
    const system = parseRegQuery(systemOutput);
    if (!system.length) {
      throw new Error('The system environment key returned no values');
    }
    return mergeEnvironment(this.baseEnvironment(), system, parseRegQuery(userOutput));
  }
}
