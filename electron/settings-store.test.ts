import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LookoutSettings } from '../src/shared/settings';
import { createDefaultSettings } from '../src/shared/settings-defaults';
import { SettingsStore, type SettingsChange, type SettingsError } from './settings-store';

let dir: string;
const stores: SettingsStore[] = [];

async function open(firstRun: () => Promise<Partial<LookoutSettings> | null> = async () => null, watch = true): Promise<SettingsStore> {
  const store = await SettingsStore.open({ userDataDir: dir, firstRun, watch, debounceMs: 60 });
  stores.push(store);
  return store;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lookout-settings-'));
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore.open', () => {
  it('runs first-run once, sanitizes its result and writes settings.json', async () => {
    const firstRun = vi.fn(async () => ({ defaultProfile: 'cmd', font: { ...createDefaultSettings().font, size: 99 } }));
    const store = await open(firstRun);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(store.get().defaultProfile).toBe('cmd');
    expect(store.get().font.size).toBe(72);
    expect(store.getLoadWarnings().some((warning) => warning.includes('font.size'))).toBe(true);
    expect(store.path).toBe(join(dir, 'settings.json'));
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(store.get());
    store.dispose();

    const again = await open(firstRun);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(again.get()).toEqual(store.get());
  });

  it('falls back to defaults when first-run fails', async () => {
    const store = await open(async () => {
      throw new Error('detection exploded');
    });
    expect(store.get()).toEqual(createDefaultSettings());
    expect(store.getLoadWarnings()[0]).toContain('detection exploded');
  });

  it('reads a hand-written file with comments without rewriting it', async () => {
    const text = '// my settings\n{\n  "font": { "face": "MesloLGM Nerd Font", },\n  "gitStatus": false,\n}\n';
    await writeFile(join(dir, 'settings.json'), text);
    const firstRun = vi.fn(async () => null);
    const store = await open(firstRun);
    expect(firstRun).not.toHaveBeenCalled();
    expect(store.get().font.face).toBe('MesloLGM Nerd Font');
    expect(store.get().gitStatus).toBe(false);
    expect(await readFile(store.path, 'utf8')).toBe(text);
  });

  it('recovers from a corrupt settings.json using the backup and keeps the corrupt copy', async () => {
    const store = await open();
    await store.update((draft) => {
      draft.font.size = 15;
    });
    await store.update((draft) => {
      draft.font.size = 16;
    });
    store.dispose();
    await writeFile(store.path, '{ "font": { "size": 17 ');

    const firstRun = vi.fn(async () => null);
    const recovered = await open(firstRun);
    expect(firstRun).not.toHaveBeenCalled();
    expect(recovered.get().font.size).toBe(15);
    expect(recovered.getLoadWarnings().some((warning) => warning.includes('restored'))).toBe(true);
    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith('settings.json.corrupt-'))).toBe(true);
    expect(JSON.parse(await readFile(recovered.path, 'utf8')).font.size).toBe(15);
  });

  it('moves a valid-JSON but non-object settings.json aside instead of overwriting it', async () => {
    await writeFile(join(dir, 'settings.json'), '[1, 2, 3]');
    const store = await open(async () => ({ gitStatus: false }));
    expect(store.get().gitStatus).toBe(false);
    const corrupt = (await readdir(dir)).find((file) => file.startsWith('settings.json.corrupt-'));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(dir, corrupt!), 'utf8')).toBe('[1, 2, 3]');
  });
});

describe('SettingsStore.update', () => {
  it('sanitizes, writes atomically, emits once and ignores its own write in the watcher', async () => {
    const store = await open();
    const changes: SettingsChange[] = [];
    const errors: SettingsError[] = [];
    store.onChange((change) => changes.push(change));
    store.onError((error) => errors.push(error));

    const before = store.get();
    const result = await store.update((draft) => {
      draft.font.size = 14;
      draft.terminal.scrollback = -1;
    });
    expect(result.font.size).toBe(14);
    expect(result.terminal.scrollback).toBe(0);
    expect(store.get()).toBe(result);
    expect(before.font.size).toBe(13);
    expect(JSON.parse(await readFile(store.path, 'utf8')).font.size).toBe(14);

    await sleep(400);
    await store.idle();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ source: 'update', previous: before });
    expect(changes[0].warnings[0]).toContain('scrollback');
    expect(errors).toEqual([]);
  });

  it('serializes concurrent updates', async () => {
    const store = await open(async () => null, false);
    await Promise.all([
      store.update((draft) => { draft.font.size = 20; }),
      store.update((draft) => { draft.quake.enabled = false; }),
      store.update((draft) => { draft.gitStatus = false; }),
    ]);
    expect(store.get()).toMatchObject({ font: { size: 20 }, quake: { enabled: false }, gitStatus: false });
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(store.get());
  });

  it('rejects and keeps settings when the mutator throws; skips no-op writes', async () => {
    const store = await open(async () => null, false);
    await expect(store.update(() => {
      throw new Error('nope');
    })).rejects.toThrow('nope');
    const unchanged = await store.update(() => undefined);
    expect(unchanged).toBe(store.get());
    expect((await readdir(dir)).includes('settings.json.bak')).toBe(false);
  });
});

describe('SettingsStore external edits', () => {
  it('picks up an external edit (comments allowed) and refreshes the backup', async () => {
    const store = await open();
    const changes: SettingsChange[] = [];
    store.onChange((change) => changes.push(change));
    await sleep(100);

    await writeFile(store.path, '{\n  // bigger\n  "font": { "size": 18 },\n}\n');
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000, interval: 25 });
    expect(changes[0].source).toBe('external');
    expect(store.get().font.size).toBe(18);
    // Untouched fields come from the defaults.
    expect(store.get().font.face).toBe('Cascadia Mono');
    await store.idle();
    expect(await readFile(`${store.path}.bak`, 'utf8')).toContain('bigger');
  });

  it('keeps the last good settings and reports a parse error, then recovers', async () => {
    const store = await open();
    await store.update((draft) => { draft.font.size = 15; });
    const changes: SettingsChange[] = [];
    const errors: SettingsError[] = [];
    store.onChange((change) => changes.push(change));
    store.onError((error) => errors.push(error));
    await sleep(100);

    await writeFile(store.path, '{ "font": { "size": 19 ');
    await vi.waitFor(() => expect(errors.some((error) => error.kind === 'parse')).toBe(true), { timeout: 3000, interval: 25 });
    expect(store.get().font.size).toBe(15);
    expect(changes).toHaveLength(0);

    await writeFile(store.path, '{ "font": { "size": 19 }, "terminal": { "cursorStyle": "nope" } }');
    await vi.waitFor(() => expect(store.get().font.size).toBe(19), { timeout: 3000, interval: 25 });
    expect(errors.some((error) => error.kind === 'validation' && error.details?.some((detail) => detail.includes('cursorStyle')))).toBe(true);
  });

  it('moves an unparseable external edit aside before an update overwrites it', async () => {
    const store = await open();
    const errors: SettingsError[] = [];
    store.onError((error) => errors.push(error));
    await sleep(100);
    await writeFile(store.path, '{ "half": ');
    await vi.waitFor(() => expect(errors.some((error) => error.kind === 'parse')).toBe(true), { timeout: 3000, interval: 25 });

    await store.update((draft) => { draft.gitStatus = false; });
    const files = await readdir(dir);
    const corrupt = files.find((file) => file.startsWith('settings.json.corrupt-'));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(dir, corrupt!), 'utf8')).toBe('{ "half": ');
    expect(JSON.parse(await readFile(store.path, 'utf8')).gitStatus).toBe(false);
  });

  it('stops watching after dispose', async () => {
    const store = await open();
    const listener = vi.fn();
    store.onChange(listener);
    store.dispose();
    await writeFile(store.path, '{ "gitStatus": false }');
    await sleep(300);
    expect(listener).not.toHaveBeenCalled();
    await expect(store.update(() => undefined)).rejects.toThrow('disposed');
  });
});
