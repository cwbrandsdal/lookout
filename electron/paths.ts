import { app } from 'electron';
import path from 'node:path';

/** Resolves runtime resource locations for dev (`npm run dev`) and packaged builds. */
export const paths = {
  get appRoot(): string {
    return app.getAppPath();
  },

  /** Folder with lookout.ps1 / lookout.bash. Packaged via electron-builder extraResources. */
  get shellIntegrationDir(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'shell-integration')
      : path.join(app.getAppPath(), 'resources', 'shell-integration');
  },

  /** Folder with the default-terminal handoff helper. */
  get nativeDir(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(app.getAppPath(), 'native', 'handoff', 'bin');
  },

  get windowIcon(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'app-icon.ico') : path.join(app.getAppPath(), 'public', 'app-icon.ico');
  },

  get trayIcon(): string {
    return this.windowIcon;
  },

  get preload(): string {
    return path.join(__dirname, 'preload.cjs');
  },

  get ptyHost(): string {
    return path.join(__dirname, 'pty-host.cjs');
  },

  get rendererIndex(): string {
    return path.join(__dirname, '../dist/index.html');
  },

  /** Executable + leading args used to relaunch Lookout (dev needs the app path). */
  get launchCommand(): { exe: string; args: string[] } {
    return app.isPackaged ? { exe: process.execPath, args: [] } : { exe: process.execPath, args: [app.getAppPath()] };
  },
};
