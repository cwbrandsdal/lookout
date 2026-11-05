import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updater: null as unknown, appListeners: [] as Array<[string, () => void]> }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    on: (event: string, listener: () => void) => mocks.appListeners.push([event, listener]),
  },
}));
vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const updater = Object.assign(new Emitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  mocks.updater = updater;
  return { autoUpdater: updater };
});

import { createUpdater, normalizeReleaseNotes, type AppUpdateState } from './updater';

type MockUpdater = EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
};

function updater(): MockUpdater {
  return mocks.updater as unknown as MockUpdater;
}

beforeEach(() => {
  vi.useFakeTimers();
  updater().removeAllListeners();
  updater().checkForUpdates.mockClear();
  updater().downloadUpdate.mockClear();
  updater().quitAndInstall.mockClear();
  mocks.appListeners.length = 0;
});

function emitApp(event: string): void {
  for (const [name, listener] of mocks.appListeners) {
    if (name === event) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createUpdater', () => {
  it('is inert in unpackaged builds', async () => {
    const states: AppUpdateState[] = [];
    const instance = createUpdater({ onState: (state) => states.push(state) });
    expect(instance.getState()).toMatchObject({ phase: 'unsupported', currentVersion: '0.0.0-test' });
    await instance.check();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updater().checkForUpdates).not.toHaveBeenCalled();
    instance.dispose();
  });

  it('auto-downloads, installs on quit, checks after 10 s and every 6 h', async () => {
    const states: AppUpdateState[] = [];
    const instance = createUpdater({ onState: (state) => states.push(state), isPackaged: true, currentVersion: '1.0.0' });
    expect(updater().autoDownload).toBe(true);
    expect(updater().autoInstallOnAppQuit).toBe(true);

    vi.advanceTimersByTime(9_999);
    expect(updater().checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(updater().checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(updater().checkForUpdates).toHaveBeenCalledTimes(2);

    updater().emit('checking-for-update');
    updater().emit('update-available', { version: '1.1.0', releaseNotes: [{ note: ' A ' }, { note: 'B' }] });
    updater().emit('download-progress', { percent: 50, bytesPerSecond: 1, transferred: 5, total: 10 });
    expect(instance.getState()).toMatchObject({ phase: 'downloading', availableVersion: '1.1.0', percent: 50, releaseNotes: 'A\n\nB' });

    // No restart is ever triggered on its own.
    updater().emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\x.exe' });
    expect(instance.getState()).toMatchObject({ phase: 'downloaded', percent: 100, downloadedFile: 'C:\\x.exe' });
    await instance.check();
    expect(updater().checkForUpdates).toHaveBeenCalledTimes(2);
    vi.runOnlyPendingTimers();
    expect(updater().quitAndInstall).not.toHaveBeenCalled();
    expect(states.map((state) => state.phase)).toEqual(['checking', 'available', 'downloading', 'downloaded']);

    // Explicit install only.
    instance.install();
    vi.runOnlyPendingTimers();
    expect(updater().quitAndInstall).toHaveBeenCalledWith(false, true);
    instance.dispose();
  });

  it('reports errors and only downloads when an update is available', async () => {
    const instance = createUpdater({ onState: () => undefined, isPackaged: true, currentVersion: '1.0.0' });
    updater().checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    expect(await instance.check()).toMatchObject({ phase: 'error', error: 'offline' });

    updater().emit('update-not-available');
    await instance.download();
    expect(updater().downloadUpdate).not.toHaveBeenCalled();
    updater().emit('update-available', { version: '2.0.0' });
    await instance.download();
    expect(updater().downloadUpdate).toHaveBeenCalledTimes(1);
    instance.install();
    expect(updater().quitAndInstall).not.toHaveBeenCalled();
    instance.dispose();
  });

  it('can be turned off with a reason (the administrator window)', async () => {
    const instance = createUpdater({ onState: () => undefined, isPackaged: true, disabledReason: 'Updates install from the normal Lookout window.' });
    expect(instance.getState()).toMatchObject({ phase: 'unsupported', error: 'Updates install from the normal Lookout window.' });
    await instance.check();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updater().checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.appListeners).toEqual([]);
    instance.dispose();
  });

  it('holds an update back while something blocks the install', () => {
    let blocker: string | undefined = 'Close the administrator window first.';
    const states: AppUpdateState[] = [];
    const instance = createUpdater({ onState: (state) => states.push(state), isPackaged: true, currentVersion: '1.0.0', installBlocker: () => blocker });
    updater().emit('update-downloaded', { version: '1.1.0' });

    instance.install();
    vi.runOnlyPendingTimers();
    expect(updater().quitAndInstall).not.toHaveBeenCalled();
    expect(instance.getState()).toMatchObject({ phase: 'downloaded', error: 'Close the administrator window first.' });
    emitApp('will-quit');
    expect(updater().autoInstallOnAppQuit).toBe(false);

    blocker = undefined;
    emitApp('will-quit');
    expect(updater().autoInstallOnAppQuit).toBe(true);
    instance.install();
    vi.runOnlyPendingTimers();
    expect(updater().quitAndInstall).toHaveBeenCalledWith(false, true);
    instance.dispose();
  });

  it('normalizes release notes', () => {
    expect(normalizeReleaseNotes(null)).toBeUndefined();
    expect(normalizeReleaseNotes('x')).toBe('x');
    expect(normalizeReleaseNotes([{ note: '' }, { note: null }])).toBeUndefined();
  });
});
