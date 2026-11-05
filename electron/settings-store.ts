// settings.json: user-editable (comments allowed), validated on every load,
// written atomically, and watched for external edits. Settings objects are
// treated immutably: every change produces a new object.

import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { LookoutSettings } from '../src/shared/settings';
import { createDefaultSettings, sanitizeSettings } from '../src/shared/settings-defaults';
import { corruptFileSuffix, readJsonWithBackup, writeFileAtomic } from './atomic-file';
import { parseJsonc } from './profiles/jsonc';

export const SETTINGS_FILE_NAME = 'settings.json';

export interface SettingsChange {
  settings: LookoutSettings;
  previous: LookoutSettings;
  source: 'update' | 'external';
  /** Corrections sanitizeSettings made (invalid values replaced or clamped). */
  warnings: string[];
}

export interface SettingsError {
  /** `parse`: settings.json is not valid JSON(C); `validation`: some values were invalid; `io`: read/write/watch failure. */
  kind: 'parse' | 'validation' | 'io';
  message: string;
  details?: string[];
}

export interface SettingsStoreOptions {
  userDataDir: string;
  /** Runs when there is no settings.json (nor a usable backup); its result is sanitized over the defaults. */
  firstRun: () => Promise<Partial<LookoutSettings> | null>;
  /** Watch settings.json for external edits. Default true. */
  watch?: boolean;
  /** Debounce for external edits. Default 150 ms. */
  debounceMs?: number;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function serialize(settings: LookoutSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSettingsObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGoodSettingsText(text: string): boolean {
  try {
    return isSettingsObject(parseJsonc(text));
  } catch {
    return false;
  }
}

export class SettingsStore {
  readonly path: string;
  private readonly dir: string;
  private readonly debounceMs: number;
  private settings: LookoutSettings;
  private readonly loadWarnings: string[];
  private readonly changeListeners = new Set<(change: SettingsChange) => void>();
  private readonly errorListeners = new Set<(error: SettingsError) => void>();
  /** Hash of the settings.json content last read or written by the store. */
  private diskHash: string | null = null;
  /** settings.json currently holds an external edit that does not parse. */
  private diskBroken = false;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  /** Serializes writes and external reloads so a reload never reads a half-applied update. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(dir: string, settings: LookoutSettings, loadWarnings: string[], debounceMs: number) {
    this.dir = dir;
    this.path = join(dir, SETTINGS_FILE_NAME);
    this.settings = settings;
    this.loadWarnings = loadWarnings;
    this.debounceMs = debounceMs;
  }

  static async open(options: SettingsStoreOptions): Promise<SettingsStore> {
    const dir = options.userDataDir;
    await mkdir(dir, { recursive: true });
    const path = join(dir, SETTINGS_FILE_NAME);
    const warnings: string[] = [];
    const read = await readJsonWithBackup(path, { parse: parseJsonc });

    let settings: LookoutSettings;
    let textToWrite: string | null = null;
    let diskText: string | undefined;
    if (read.source === 'none' || !isSettingsObject(read.value)) {
      if (read.error) {
        warnings.push(`${read.error} Settings were rebuilt from detection and imports.`);
      } else if (read.source !== 'none') {
        // Valid JSON but not an object: keep the file instead of overwriting it.
        const target = `${path}${corruptFileSuffix(new Date())}`;
        const moved = await rename(read.source === 'primary' ? path : `${path}.bak`, target).then(() => true, () => false);
        warnings.push(`${path} did not contain a settings object${moved ? `; it was moved to ${target}` : ''}. Settings were rebuilt.`);
      }
      let initial: Partial<LookoutSettings> | null = null;
      try {
        initial = await options.firstRun();
      } catch (error) {
        warnings.push(`First-run import failed (${errorMessage(error)}); defaults were used.`);
      }
      const sanitized = sanitizeSettings(initial ?? {}, createDefaultSettings());
      settings = sanitized.settings;
      warnings.push(...sanitized.warnings);
      textToWrite = serialize(settings);
    } else {
      const sanitized = sanitizeSettings(read.value);
      settings = sanitized.settings;
      warnings.push(...sanitized.warnings);
      if (read.source === 'backup') {
        warnings.push(`${read.error ?? `${path} was missing.`} Settings were restored from ${path}.bak.`);
        textToWrite = serialize(settings);
      } else {
        diskText = read.text;
      }
    }

    const store = new SettingsStore(dir, settings, warnings, options.debounceMs ?? 150);
    if (textToWrite !== null) {
      store.diskHash = hash(textToWrite);
      try {
        await writeFileAtomic(path, textToWrite, { isGood: isGoodSettingsText });
      } catch (error) {
        warnings.push(`Could not write ${path} (${errorMessage(error)}).`);
      }
    } else if (diskText !== undefined) {
      store.diskHash = hash(diskText);
    }

    if (options.watch !== false) store.startWatching();
    return store;
  }

  /** Current settings. Never mutate the returned object; use update(). */
  get(): LookoutSettings {
    return this.settings;
  }

  /** Corrections and recoveries from open() (there were no listeners yet). */
  getLoadWarnings(): string[] {
    return [...this.loadWarnings];
  }

  /**
   * Applies `mutator` to a copy, sanitizes it, writes settings.json atomically and emits a
   * change. Updates are serialized. Rejects (leaving settings unchanged) if the mutator
   * throws or the file cannot be written.
   */
  update(mutator: (draft: LookoutSettings) => void): Promise<LookoutSettings> {
    const run = async (): Promise<LookoutSettings> => {
      if (this.disposed) throw new Error('SettingsStore is disposed.');
      const draft = structuredClone(this.settings);
      mutator(draft);
      const { settings, warnings } = sanitizeSettings(draft);
      const text = serialize(settings);
      if (text === serialize(this.settings) && !this.diskBroken) return this.settings;

      if (this.diskBroken) await this.preserveBrokenFile();
      const previousHash = this.diskHash;
      this.diskHash = hash(text);
      try {
        await writeFileAtomic(this.path, text, { isGood: isGoodSettingsText });
      } catch (error) {
        this.diskHash = previousHash;
        this.emitError({ kind: 'io', message: `Could not save ${this.path}: ${errorMessage(error)}` });
        throw error;
      }
      this.diskBroken = false;
      this.apply(settings, 'update', warnings);
      return settings;
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  onChange(listener: (change: SettingsChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onError(listener: (error: SettingsError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.changeListeners.clear();
    this.errorListeners.clear();
  }

  /** Resolves once pending writes and reloads have finished (for shutdown and tests). */
  async idle(): Promise<void> {
    await this.queue;
  }

  // ---- Internals --------------------------------------------------------------

  private startWatching(): void {
    try {
      // Watch the directory: atomic saves (ours and most editors') replace the file,
      // which would orphan a watcher on the file itself.
      this.watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString().toLowerCase() !== SETTINGS_FILE_NAME) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (error) => {
        this.emitError({ kind: 'io', message: `Stopped watching ${this.path} for external edits: ${errorMessage(error)}` });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (error) {
      this.emitError({ kind: 'io', message: `Cannot watch ${this.path} for external edits: ${errorMessage(error)}` });
    }
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.queue = this.queue.then(() => this.reloadFromDisk()).catch(() => undefined);
    }, this.debounceMs);
  }

  private async reloadFromDisk(): Promise<void> {
    if (this.disposed) return;
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      // Deleted or mid-replace: keep the current settings; the next event re-checks.
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.emitError({ kind: 'io', message: `Could not read ${this.path}: ${errorMessage(error)}` });
      }
      return;
    }

    const contentHash = hash(text);
    if (contentHash === this.diskHash) return;
    this.diskHash = contentHash;

    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
      if (!isSettingsObject(parsed)) throw new Error('the file must contain a JSON object');
    } catch (error) {
      this.diskBroken = true;
      this.emitError({
        kind: 'parse',
        message: `settings.json has an error (${errorMessage(error)}). Lookout keeps using the last valid settings until it is fixed.`,
      });
      return;
    }

    this.diskBroken = false;
    const { settings, warnings } = sanitizeSettings(parsed);
    if (warnings.length) {
      this.emitError({ kind: 'validation', message: 'Some values in settings.json are invalid; defaults are used for them.', details: warnings });
    }
    // The user's file is now the last good version: keep it as the backup.
    await writeFileAtomic(`${this.path}.bak`, text, { backup: false }).catch(() => undefined);
    this.apply(settings, 'external', warnings);
  }

  /** Before overwriting an external edit that does not parse, move it aside so it is not lost. */
  private async preserveBrokenFile(): Promise<void> {
    const target = `${this.path}${corruptFileSuffix(new Date())}`;
    try {
      await rename(this.path, target);
      this.emitError({ kind: 'parse', message: `settings.json did not parse; your edited copy was saved as ${target}.` });
    } catch (error) {
      this.emitError({ kind: 'io', message: `Could not keep a copy of the unparseable settings.json: ${errorMessage(error)}` });
    }
  }

  private apply(settings: LookoutSettings, source: SettingsChange['source'], warnings: string[]): void {
    if (serialize(settings) === serialize(this.settings)) return;
    const previous = this.settings;
    this.settings = settings;
    for (const listener of [...this.changeListeners]) {
      try {
        listener({ settings, previous, source, warnings });
      } catch {
        // Listener failures must not break the store.
      }
    }
  }

  private emitError(error: SettingsError): void {
    for (const listener of [...this.errorListeners]) {
      try {
        listener(error);
      } catch {
        // Ignore.
      }
    }
  }
}
