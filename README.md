# Lookout

Lookout is a Windows desktop app for organizing developer terminal work by project space.

Each top tab is a real project-space folder on disk. Each project space contains a configurable grid of real PowerShell terminal panes rendered with `xterm.js` and backed by `node-pty`.

## Stack

- Electron desktop shell
- React + TypeScript + Vite renderer
- `node-pty` terminal backend
- `xterm.js` terminal UI
- Local JSON persistence in Electron user data

## Features

- Multiple project-space tabs open at once
- Data-driven layouts for 1, 2, 4, 6, 8, 10, 12, 14, and 16 panes
- Real PowerShell sessions per pane
- Pane roles for Claude Code, Codex, Build, Git, Test, Logs, Notes, and general PowerShell
- Preset save/load/update/delete flow
- Restorable open tabs, recent paths, theme/settings, and window bounds
- Path validation, pane restart/stop/clear, copy path, and open folder actions

## Local Development

1. Install dependencies:

```powershell
npm install
```

2. Start the desktop app in development mode:

```powershell
npm run dev
```

If port `5173` conflicts with another project, set `LOOKOUT_DEV_PORT` before starting the app:

```powershell
$env:LOOKOUT_DEV_PORT=5187
npm run dev
```

## Production Build

```powershell
npm run build
npm start
```

`npm start` launches the packaged Electron main process against the built renderer in `dist/`.

## Windows Installer

Build a Windows installer:

```powershell
npm run dist:win
```

The installer is written to:

```text
release/Lookout-Setup-0.1.0.exe
```

## GitHub Releases And App Updates

Lookout is configured to publish Windows releases to GitHub Releases and consume them in-app through `electron-updater`.

### Release flow

1. Update `package.json` with the next version.
2. Commit and push `main`.
3. Create and push a tag:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

4. GitHub Actions runs `.github/workflows/release.yml` and publishes:
   - `Lookout-Setup-x.y.z.exe`
   - `latest.yml`
   - blockmap files

Installed copies of Lookout can then:
- check GitHub Releases for updates
- download the latest installer in-app
- restart to install the update

### Notes

- Auto-update works in packaged builds, not `npm run dev`.
- The app is configured for the public GitHub repo `cwbrandsdal/lookout`.
- Windows code signing is still recommended for the best SmartScreen and installer trust experience.

## Verification

```powershell
npm run lint
npm run build
.\node_modules\.bin\electron.cmd .\scripts\smoke-electron-pty.cjs
```

The smoke test confirms that `node-pty` loads correctly inside Electron on Windows.
