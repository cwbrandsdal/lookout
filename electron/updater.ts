// App updates via electron-updater (GitHub releases). Updates download in the
// background and install when the app next quits; Lookout never restarts on
// its own. install() is for an explicit "Restart to update" action.
// Only the normal instance updates, and not while the administrator window is open:
// the installer can't close an elevated Lookout, and an elevated installer would
// force-close the normal one.

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export type AppUpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  downloadedFile?: string;
  checkedAt?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

export interface UpdaterOptions {
  onState(state: AppUpdateState): void;
  /** Delay before the first check. Default 10 s. */
  initialCheckDelayMs?: number;
  /** Interval between checks. Default 6 h. */
  checkIntervalMs?: number;
  /** Defaults to app.isPackaged (updates only work in installed builds). */
  isPackaged?: boolean;
  /** Defaults to app.getVersion(). */
  currentVersion?: string;
  /** Turns updates off with this explanation (the administrator window leaves them to the normal one). */
  disabledReason?: string;
  /**
   * Returns why a downloaded update can't be installed right now, if it can't. It holds
   * back both "Restart to install" and the install on quit.
   */
  installBlocker?: () => string | undefined;
}

export interface Updater {
  getState(): AppUpdateState;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  /** Quits and installs a downloaded update (explicit user action only). */
  install(): void;
  dispose(): void;
}

const UNSUPPORTED_MESSAGE = 'Updates are available in the installed app.';

export function normalizeReleaseNotes(releaseNotes: string | Array<{ note?: string | null }> | null | undefined): string | undefined {
  if (!releaseNotes) return undefined;
  if (typeof releaseNotes === 'string') return releaseNotes;
  const notes = releaseNotes.map((entry) => entry.note?.trim()).filter((entry): entry is string => Boolean(entry));
  return notes.length ? notes.join('\n\n') : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdater(options: UpdaterOptions): Updater {
  const currentVersion = options.currentVersion ?? app.getVersion();
  const packaged = (options.isPackaged ?? app.isPackaged) && !options.disabledReason;
  let state: AppUpdateState = packaged
    ? { phase: 'idle', currentVersion }
    : { phase: 'unsupported', currentVersion, error: options.disabledReason ?? UNSUPPORTED_MESSAGE };
  const timers: NodeJS.Timeout[] = [];
  let disposed = false;

  const setState = (next: AppUpdateState) => {
    state = next;
    if (!disposed) options.onState(state);
  };

  const getState = () => state;

  const check = async (): Promise<AppUpdateState> => {
    if (!packaged || disposed) return state;
    // Re-checking while downloading would restart nothing useful; a downloaded update waits for quit.
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded') return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      setState({ ...state, phase: 'error', currentVersion, error: errorMessage(error) });
    }
    return state;
  };

  const download = async (): Promise<AppUpdateState> => {
    if (!packaged || disposed) return state;
    if (state.phase !== 'available' && state.phase !== 'error') return state;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      setState({ ...state, phase: 'error', currentVersion, error: errorMessage(error) });
    }
    return state;
  };

  const install = () => {
    if (!packaged || state.phase !== 'downloaded') return;
    const blocked = options.installBlocker?.();
    if (blocked) {
      setState({ ...state, error: blocked });
      return;
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  };

  const dispose = () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  };

  if (packaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // electron-updater reads the flag on 'quit', which comes after 'will-quit'.
    const { installBlocker } = options;
    if (installBlocker) {
      app.on('will-quit', () => {
        autoUpdater.autoInstallOnAppQuit = !installBlocker();
      });
    }

    autoUpdater.on('checking-for-update', () => {
      setState({ ...state, phase: 'checking', currentVersion, checkedAt: new Date().toISOString(), error: undefined });
    });
    autoUpdater.on('update-available', (info) => {
      setState({
        phase: 'available',
        currentVersion,
        availableVersion: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on('update-not-available', () => {
      setState({ phase: 'not-available', currentVersion, checkedAt: new Date().toISOString() });
    });
    autoUpdater.on('download-progress', (progress) => {
      setState({
        ...state,
        phase: 'downloading',
        currentVersion,
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
        error: undefined,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      setState({
        phase: 'downloaded',
        currentVersion,
        availableVersion: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        checkedAt: state.checkedAt ?? new Date().toISOString(),
        downloadedFile: info.downloadedFile,
        percent: 100,
      });
    });
    autoUpdater.on('error', (error) => {
      setState({ ...state, phase: 'error', currentVersion, error: error?.message ?? String(error) });
    });

    const initialDelay = options.initialCheckDelayMs ?? 10_000;
    const interval = options.checkIntervalMs ?? 6 * 60 * 60 * 1000;
    const first = setTimeout(() => {
      void check();
      const repeat = setInterval(() => void check(), interval);
      repeat.unref?.();
      timers.push(repeat);
    }, initialDelay);
    first.unref?.();
    timers.push(first);
  }

  return { getState, check, download, install, dispose };
}
