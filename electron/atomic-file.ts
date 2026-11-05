// Crash-safe file persistence. v1 wrote lookout-state.json in place, so a crash
// or a full disk mid-write could leave a truncated file that the next start
// silently replaced with defaults. Here every write goes to a temp file that is
// fsynced and renamed over the target, the previous good file is kept as
// `.bak`, and an unreadable file is moved aside instead of being overwritten.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseJsonc } from './profiles/jsonc';

/** Windows: antivirus, indexers and editors briefly hold files open without FILE_SHARE_DELETE. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [15, 30, 60, 120, 250, 400, 600];

export interface WriteFileAtomicOptions {
  /** Copy the current file to `<path>.bak` before replacing it. Default true. */
  backup?: boolean;
  /**
   * Decides whether the current file is worth keeping as `.bak` (so a corrupt file
   * never replaces a good backup). Default: non-empty, and for `.json` files it must
   * parse (comments allowed).
   */
  isGood?: (current: string) => boolean;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !RETRYABLE_CODES.has(errorCode(error) ?? '')) throw error;
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function defaultIsGood(path: string): (current: string) => boolean {
  if (!/\.json$/i.test(path)) return (current) => current.length > 0;
  return (current) => {
    if (!current.trim()) return false;
    try {
      parseJsonc(current);
      return true;
    } catch {
      return false;
    }
  };
}

/** Writes `data` to a fresh temp file next to `path`, fsyncs it and renames it over `path`. */
async function replaceFile(path: string, data: string | Uint8Array, beforeRename?: () => Promise<void>): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await beforeRename?.();
    await withRetry(() => rename(tmp, path));
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function backupCurrent(path: string, isGood: (current: string) => boolean): Promise<void> {
  let current: Buffer;
  try {
    current = await withRetry(() => readFile(path));
  } catch {
    return; // Nothing to back up (first write) or unreadable; the write itself decides.
  }

  if (!isGood(current.toString('utf8'))) return;
  await replaceFile(`${path}.bak`, current);
}

export async function writeFileAtomic(path: string, data: string | Uint8Array, options: WriteFileAtomicOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const backup = options.backup ?? true;
  const isGood = options.isGood ?? defaultIsGood(path);
  await replaceFile(path, data, backup
    ? async () => {
      // Best effort: a failed backup must not block saving the new data.
      await backupCurrent(path, isGood).catch(() => undefined);
    }
    : undefined);
}

export type JsonReadSource = 'primary' | 'backup' | 'none';

export interface JsonReadResult {
  value: unknown;
  source: JsonReadSource;
  /** Why the primary file was not used (missing files are not an error). */
  error?: string;
  /** Raw text of the file that `value` came from. */
  text?: string;
  /** Where a corrupt primary file was moved. */
  corruptPath?: string;
}

export interface ReadJsonOptions {
  /** Defaults to `JSON.parse` (a UTF-8 BOM is stripped first). */
  parse?: (text: string) => unknown;
  now?: () => Date;
}

type ReadOutcome =
  | { kind: 'ok'; value: unknown; text: string }
  | { kind: 'missing' }
  | { kind: 'corrupt'; message: string }
  | { kind: 'unreadable'; message: string };

async function tryRead(path: string, parse: (text: string) => unknown): Promise<ReadOutcome> {
  let text: string;
  try {
    text = await withRetry(() => readFile(path, 'utf8'));
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', message: errorMessage(error) };
  }

  if (!text.replace(/^\uFEFF/, '').trim()) return { kind: 'corrupt', message: 'the file is empty' };
  try {
    return { kind: 'ok', value: parse(text), text };
  } catch (error) {
    return { kind: 'corrupt', message: errorMessage(error) };
  }
}

export function corruptFileSuffix(date: Date): string {
  return `.corrupt-${date.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Reads a JSON file, falling back to `<path>.bak` when the primary file is missing,
 * unreadable or corrupt. A corrupt primary is renamed to `<path>.corrupt-<timestamp>`
 * so the next save cannot silently destroy it.
 */
export async function readJsonWithBackup(path: string, options: ReadJsonOptions = {}): Promise<JsonReadResult> {
  const parse = options.parse ?? ((text: string) => JSON.parse(text.replace(/^\uFEFF/, '')) as unknown);
  const primary = await tryRead(path, parse);
  if (primary.kind === 'ok') return { value: primary.value, source: 'primary', text: primary.text };

  let error: string | undefined;
  let corruptPath: string | undefined;
  if (primary.kind === 'corrupt') {
    corruptPath = `${path}${corruptFileSuffix((options.now ?? (() => new Date()))())}`;
    try {
      await withRetry(() => rename(path, corruptPath!));
      error = `${path} could not be parsed (${primary.message}); it was moved to ${corruptPath}.`;
    } catch (renameError) {
      error = `${path} could not be parsed (${primary.message}) and could not be moved aside (${errorMessage(renameError)}).`;
      corruptPath = undefined;
    }
  } else if (primary.kind === 'unreadable') {
    error = `${path} could not be read (${primary.message}).`;
  }

  const backup = await tryRead(`${path}.bak`, parse);
  if (backup.kind === 'ok') return { value: backup.value, source: 'backup', text: backup.text, error, corruptPath };
  if (backup.kind === 'corrupt' || backup.kind === 'unreadable') {
    error = [error, `The backup ${path}.bak is unusable too (${backup.message}).`].filter(Boolean).join(' ');
  }
  return { value: undefined, source: 'none', error, corruptPath };
}
