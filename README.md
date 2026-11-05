# Lookout

Lookout is a Windows terminal app meant to replace Windows Terminal. It is built for long sessions with many panes: tabs live in a vertical sidebar, panes split freely, shells survive UI reloads, and the app understands what your shell is doing (current folder, running command, exit codes) through shell integration.

## Highlights

- **Tabs and panes:** a vertical tab rail with a live layout glyph per tab, n-ary splits with draggable dividers, zoom, broadcast input, drag panes between tabs, and tear a tab off into its own window.
- **Real shells, quickly:** PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL distros, Visual Studio developer shells and SSH hosts are detected automatically. On first launch your Windows Terminal profiles, fonts, color schemes and keybindings are imported.
- **Shell integration** for pwsh, Windows PowerShell, cmd and Git Bash:
  - the live working directory, so new splits and tabs open where you are
  - command marks and exit codes in the gutter and on the scrollbar
  - a sticky command header while scrolled back, Ctrl+↑/↓ to jump between commands, and "copy last command output"
  - notifications when long commands finish
- **Keyboard fidelity:**
  - win32-input-mode, the same keyboard protocol as Windows Terminal, so PSReadLine gets Ctrl+Space, Ctrl+Backspace, Shift+Enter and friends
  - AltGr layouts (`@ { [ ] } \ $ €` on Nordic keyboards) are never swallowed by shortcuts
- **Reliability:**
  - shells run in a separate pty host process with VS Code-style flow control
  - a renderer reload or crash reattaches to running shells
  - closing a pane kills its whole process tree
  - session and scrollback restore on restart
  - atomic settings and state writes with backups
- **Details:**
  - find with regex, case and whole-word options
  - clickable URLs, OSC 8 hyperlinks and `file:line:col` links that open VS Code
  - right-click copy/paste, warnings before multi-line or large pastes, trimmed copies
  - bell, taskbar progress (OSC 9;4), OSC 9/777 notifications, OSC 52 clipboard writes, SIXEL images
- **Themes:** light, or one of four dark themes, from darkest to lightest: Night, Dusk, Slate (cool) and Ash (warm). Pick one in Settings → Appearance, or set `"darkTheme"` in settings.json. The terminal colors follow the theme unless you picked another color scheme.
- **Windows integration:**
  - a drop-down (quake) terminal on Win+\`
  - the tray icon keeps Lookout warm for instant windows
  - a `lookout` CLI
  - "Open in Lookout" in Explorer
  - optional default-terminal handoff, so console windows from other apps open as Lookout tabs
  - a separate, clearly marked administrator window. Right-click a workspace or open a profile's settings and choose **Run as administrator**: it then always opens there, after a UAC prompt. The administrator window shares your settings, profiles and theme.

## Keyboard

| Action | Keys |
| --- | --- |
| Command palette | Ctrl+Shift+P |
| New tab / profile menu | Ctrl+Shift+T / Ctrl+Shift+Space |
| New tab with profile N | Ctrl+Shift+1…9 |
| Split right / down / duplicate | Alt+Shift+Plus / Alt+Shift+Minus / Alt+Shift+D |
| Move focus / resize pane | Alt+Arrows / Alt+Shift+Arrows |
| Zoom pane | Ctrl+Shift+Z |
| Close pane | Ctrl+Shift+W |
| Next / previous tab, tab N | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9 |
| Reopen closed tab | Ctrl+Shift+R |
| Find | Ctrl+Shift+F |
| Copy / paste | Ctrl+C (with a selection) / Ctrl+V, Ctrl+Shift+C / Ctrl+Shift+V |
| Previous / next command | Ctrl+↑ / Ctrl+↓ |
| Font size | Ctrl+Plus / Ctrl+Minus / Ctrl+0 |
| Settings | Ctrl+, |
| Toggle sidebar | Ctrl+Shift+B |
| Drop-down terminal (global) | Win+\` |

Every shortcut can be changed under Settings → Keyboard or in `settings.json`.

## Command line

Turn on **Settings → Integrations → `lookout` command on PATH**, then:

```powershell
lookout .                                   # new tab in the current folder
lookout -d C:\src\api                       # new tab in a folder
lookout new-tab -p "Ubuntu" ; split-pane -V -p pwsh
lookout -w new                              # new window
lookout open "api"                          # open a saved workspace
```

The grammar follows Windows Terminal's `wt`.

## Files

Everything lives in `%APPDATA%\Lookout`:

- `settings.json`: preferences, profiles, color schemes, keybindings and snippets. It is user-editable and reloaded live.
- `state.json`: windows, tabs, layouts, workspaces and recent folders.
- `buffers\`: scrollback saved for session restore.

The administrator window keeps its own `state.json` and `buffers\` in `%APPDATA%\Lookout-Admin`, but uses the same `settings.json`. Workspaces marked "Run as administrator" are copied into it whenever they're opened. A copy edited in the administrator window is kept until the original changes.

A v1 `lookout-state.json` is migrated on first launch: project spaces become workspaces and open spaces become tabs. The old file is kept as `lookout-state.v1-migrated.json`.

## Development

```powershell
npm install
npm run dev            # Vite + esbuild watch + Electron
npm test               # unit + integration tests (spawns real shells via ConPTY)
npm run lint
npm run build          # typecheck + renderer + electron bundles
node scripts/ui-smoke.mjs C:\temp\shots   # drives the built app end-to-end, saves screenshots
node scripts/ui-panes.mjs                 # pane editing: anchors, drag to dock/swap, dividers
node scripts/ui-anchors.mjs               # split anchors under realistic mouse use (jitter, slide-off, Esc)
node scripts/ui-admin.mjs                 # "Run as administrator" workspaces, with a stand-in admin instance (no UAC)
```

The UI scripts run the dev build; set `$env:LOOKOUT_EXE` to a packaged `Lookout.exe` to test that instead (`ui-smoke.mjs` uses `LOOKOUT_SMOKE_EXE`). Playwright clicks don't move the pointer between press and release, so mouse-heavy features also need a jittered press/move/release check like the ones in `ui-anchors.mjs`.

If port 5173 is busy, set `$env:LOOKOUT_DEV_PORT=5187` first.

The default-terminal helper is native C++ (MSVC + Windows SDK):

```powershell
npm run build:native   # builds native/handoff/bin/LookoutHandoff.exe + proxy DLL
.\native\handoff\bin\LookoutHandoffSelfTest.exe   # COM + pipe self-test, no system changes
```

### Default terminal

When **Settings → Integrations → Default terminal app** is on, Windows hands new console windows (double-clicked `.bat` files, Win+R `cmd`, `start pwsh`) to Windows Terminal's OpenConsole. OpenConsole then activates Lookout's COM helper, and the console opens as a Lookout tab. The helper's log is at `%LOCALAPPDATA%\Lookout\logs\handoff.log`. Turning the setting off restores whatever default terminal you had before.

Both end-to-end tests change `HKCU\Console\%%Startup` for a few seconds and restore it afterwards, so they are opt-in:

```powershell
.\scripts\test-handoff-live.ps1                 # Windows → helper → a minimal receiver
node scripts/handoff-e2e.mjs --i-consent        # Windows → helper → the real Lookout app (a new tab)
```

## Architecture

| Process | Responsibility |
| --- | --- |
| `electron/main.ts` | Windows, tray, global hotkeys, CLI routing, settings/state stores, integrations, git status, updates |
| `electron/pty-host/*` (utilityProcess) | Every shell: node-pty + ConPTY, headless xterm mirror for reattach snapshots, flow control, process-tree kill, default-terminal handoff server |
| `src/` (renderer) | React UI, xterm.js terminals, keymap, shell-integration parsing, win32-input-mode encoder |
| `native/handoff` | COM server implementing `ITerminalHandoff3` for Windows default-terminal delegation |

Each window gets its own MessagePort straight to the pty host; terminal data never passes through the main process.

## Releases

1. Bump `version` in `package.json`, commit, and push `main`.
2. Tag and push the tag:

   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. `.github/workflows/release.yml` builds the native helper and the NSIS installer, then publishes to GitHub Releases.

Installed copies download updates in the background. An update installs when Lookout quits, or right away with **Update** in the sidebar (or Settings → About → Restart to install). Only the normal window updates: the administrator window leaves it to the normal one, and an update waits while an administrator window is open, because the installer can't close an elevated Lookout. Code signing is still recommended, especially for the default-terminal helper.
