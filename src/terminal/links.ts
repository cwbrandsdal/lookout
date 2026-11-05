// Clickable file paths (`src\app.ts:12:3`, `C:\logs\out.txt`, `./build/index.html(4,2)`)
// resolved against the pane's live working directory. URLs are handled by the
// web-links addon and OSC 8 hyperlinks by xterm's linkHandler.

import type { IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

import type { PathProbe } from '../shared/ipc';

export interface FileLinkTarget {
  path: string;
  isDirectory: boolean;
  line?: number;
  column?: number;
}

export interface FileLinkOptions {
  getCwd: () => string | undefined;
  probe: (inputs: string[], cwd: string) => Promise<PathProbe[]>;
  activate: (event: MouseEvent, target: FileLinkTarget) => void;
  hover?: (event: MouseEvent, target: FileLinkTarget) => void;
  leave?: () => void;
}

const CANDIDATE = /(?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/[a-zA-Z]\/)?(?:[\w.@$%+~-]+[\\/])*[\w@$%+~-][\w.@$%+~-]*(?::\d+(?::\d+)?|\(\d+(?:,\s?\d+)?\))?/g;
const SUFFIX = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))$/;
const CACHE_TTL_MS = 8000;

interface CacheEntry {
  probe: PathProbe;
  at: number;
}

export function extractCandidates(text: string): Array<{ start: number; raw: string; path: string; line?: number; column?: number }> {
  const results: Array<{ start: number; raw: string; path: string; line?: number; column?: number }> = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (raw.length < 3) {
      continue;
    }

    // Skip URLs (handled elsewhere) and things that are obviously not paths.
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith('://') || /^\d+(\.\d+)*$/.test(raw)) {
      continue;
    }

    const suffix = SUFFIX.exec(raw);
    const path = suffix ? raw.slice(0, suffix.index) : raw;
    const hasSeparator = /[\\/]/.test(path);
    const hasExtension = /\.[a-zA-Z][\w-]{0,9}$/.test(path);
    if (!hasSeparator && !hasExtension) {
      continue;
    }

    const line = suffix ? Number(suffix[1] ?? suffix[3]) : undefined;
    const column = suffix ? Number(suffix[2] ?? suffix[4]) || undefined : undefined;
    results.push({ start, raw, path: path.replace(/[.,;:]+$/, ''), line, column });
    if (results.length >= 24) {
      break;
    }
  }
  return results;
}

export function createFileLinkProvider(terminal: Terminal, options: FileLinkOptions): ILinkProvider {
  const cache = new Map<string, CacheEntry>();

  return {
    provideLinks(bufferLineNumber, callback) {
      const cwd = options.getCwd();
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!cwd || !line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const candidates = extractCandidates(text);
      if (!candidates.length) {
        callback(undefined);
        return;
      }

      const now = Date.now();
      const missing = candidates.map((candidate) => candidate.path).filter((path) => {
        const entry = cache.get(`${cwd}|${path}`);
        return !entry || now - entry.at > CACHE_TTL_MS;
      });

      const finish = () => {
        const links: ILink[] = [];
        for (const candidate of candidates) {
          const probe = cache.get(`${cwd}|${candidate.path}`)?.probe;
          if (!probe?.resolved) {
            continue;
          }

          const target: FileLinkTarget = { path: probe.resolved, isDirectory: probe.isDirectory, line: candidate.line, column: candidate.column };
          const start: IBufferCellPosition = { x: candidate.start + 1, y: bufferLineNumber };
          const end: IBufferCellPosition = { x: candidate.start + candidate.raw.length, y: bufferLineNumber };
          links.push({
            range: { start, end },
            text: candidate.raw,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => options.activate(event, target),
            hover: (event) => options.hover?.(event, target),
            leave: () => options.leave?.(),
          });
        }
        callback(links.length ? links : undefined);
      };

      if (!missing.length) {
        finish();
        return;
      }

      void options
        .probe([...new Set(missing)], cwd)
        .then((probes) => {
          const at = Date.now();
          for (const probe of probes) {
            cache.set(`${cwd}|${probe.input}`, { probe, at });
          }
          if (cache.size > 2000) {
            cache.clear();
          }
          finish();
        })
        .catch(() => callback(undefined));
    },
  };
}
