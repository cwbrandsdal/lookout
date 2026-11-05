import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { expandEnvVars } from '../../src/shared/commandline';

function statements(text: string): string[][] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
    const tokens: string[] = [];
    let token = '';
    let quote = '';
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '\\' && i + 1 < line.length && /[\s"'\\#]/.test(line[i + 1])) {
        token += line[++i];
      } else if (quote) {
        if (char === quote) quote = '';
        else token += char;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '#') {
        break;
      } else if (/\s/.test(char) || (char === '=' && (tokens.length === 0 || (tokens.length === 1 && !token)))) {
        if (token) tokens.push(token);
        token = '';
      } else {
        token += char;
      }
    }
    if (token) tokens.push(token);
    return tokens;
  });
}

function addHosts(hosts: Map<string, string>, values: string[]): void {
  for (const host of values) {
    if (host && !/[*?!]/.test(host) && !hosts.has(host.toLowerCase())) {
      hosts.set(host.toLowerCase(), host);
    }
  }
}

/** Concrete aliases only; does not interpret HostName, Match, or execute any SSH commands. */
export function parseSshConfigHosts(text: string): string[] {
  const hosts = new Map<string, string>();
  for (const [keyword, ...values] of statements(text)) {
    if (keyword?.toLowerCase() === 'host') addHosts(hosts, values);
  }
  return [...hosts.values()];
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
  } catch {
    return /$a/;
  }
}

async function expandInclude(pattern: string): Promise<string[]> {
  const absolute = resolve(pattern);
  const root = parse(absolute).root;
  let paths = [root];
  for (const part of absolute.slice(root.length).split(/[\\/]/)) {
    if (!/[*?[]/.test(part)) {
      paths = paths.map((parent) => join(parent, part));
      continue;
    }
    const matcher = wildcard(part);
    const matches = await Promise.all(paths.map(async (parent) => {
      const entries = await readdir(parent).catch(() => [] as string[]);
      return entries.filter((entry) => matcher.test(entry)).sort().map((entry) => join(parent, entry));
    }));
    paths = matches.flat();
  }
  return paths;
}

/**
 * Load a user SSH config and its Include fragments. As in OpenSSH, relative
 * Includes are rooted at the user config directory, even inside included files.
 * Missing files, Include cycles, and unreadable fragments are ignored.
 */
export async function loadSshConfigHosts(
  filePath: string,
  options: { env?: NodeJS.ProcessEnv; maxDepth?: number } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const base = dirname(resolve(filePath));
  const visited = new Set<string>();
  const hosts = new Map<string, string>();
  const maxDepth = options.maxDepth ?? 16;

  async function visit(file: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited.size >= 256) return;
    try {
      const canonical = await realpath(file);
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (visited.has(key)) return;
      visited.add(key);
      for (const [keyword, ...values] of statements(await readFile(canonical, 'utf8'))) {
        if (keyword?.toLowerCase() === 'host') addHosts(hosts, values);
        if (keyword?.toLowerCase() !== 'include') continue;
        for (const value of values) {
          const expanded = expandEnvVars(value, env);
          const pattern = isAbsolute(expanded) ? expanded : resolve(base, expanded);
          for (const included of await expandInclude(pattern)) await visit(included, depth + 1);
        }
      }
    } catch {
      // Discovery must still work when one optional fragment is inaccessible.
    }
  }

  await visit(filePath, 0);
  return [...hosts.values()];
}
