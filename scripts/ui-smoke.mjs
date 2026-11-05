// End-to-end smoke test of the built app (run `npm run build` first).
// Launches Electron with an isolated profile, drives real shells, and saves
// screenshots to the folder given as the first argument (default: %TEMP%).
//
//   node scripts/ui-smoke.mjs C:\temp\lookout-shots

import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'lookout-shots'));
await mkdir(shots, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'lookout-smoke-'));

const failures = [];
const check = (condition, message) => {
  if (!condition) {
    failures.push(message);
    console.error(`FAIL ${message}`);
  } else {
    console.log(`ok   ${message}`);
  }
};

const env = { ...process.env, LOOKOUT_TEST: '1', LOOKOUT_USER_DATA_DIR: userData };
// Running inside another Electron app (e.g. an agent host) can leak this, which turns Electron into Node.
delete env.ELECTRON_RUN_AS_NODE;

// LOOKOUT_SMOKE_EXE=release\win-unpacked\Lookout.exe tests the packaged app instead of the dev build.
const packagedExe = process.env.LOOKOUT_SMOKE_EXE ? path.resolve(process.env.LOOKOUT_SMOKE_EXE) : null;

async function launchApp() {
  const instance = await electron.launch({
    executablePath: packagedExe ?? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packagedExe ? [] : [root],
    cwd: root,
    env,
    timeout: 60_000,
  });
  const forward = (chunk) => {
    const text = String(chunk);
    if (!/Debugger|nodejs\.org\/en\/docs\/inspector/.test(text)) {
      process.stdout.write(`[main] ${text}`);
    }
  };
  instance.process().stdout?.on('data', forward);
  instance.process().stderr?.on('data', forward);
  return instance;
}

let app = await launchApp();

try {
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.log(`[renderer:error] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => console.log(`[renderer:pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});

  await page.waitForSelector('.tabrow', { timeout: 60_000 });
  await page.waitForSelector('.xterm', { timeout: 30_000 });

  const focusedPane = () => page.evaluate(() => window.__lookoutDebug.state().tabs.find((tab) => tab.id === window.__lookoutDebug.state().activeTabId)?.focusedPaneId);
  const bufferOf = (paneId) => page.evaluate((id) => window.__lookoutDebug.bufferText(id), paneId);
  const waitForText = async (paneId, needle, timeout = 25_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if ((await bufferOf(paneId)).includes(needle)) {
        return true;
      }
      await page.waitForTimeout(200);
    }
    return false;
  };

  const first = await focusedPane();
  check(Boolean(first), 'a tab with a focused pane exists on boot');

  // Wait for the shell (profile + shell integration) to be ready.
  const promptReady = await page.waitForFunction(
    (id) => {
      const runtime = window.__lookoutDebug.state().runtime[id];
      return runtime && runtime.status === 'running' && runtime.integrated;
    },
    first,
    { timeout: 45_000 },
  ).then(() => true, () => false);
  check(promptReady, 'shell started with shell integration');
  await page.screenshot({ path: path.join(shots, '01-boot.png') });

  const info = await page.evaluate((id) => window.__lookoutDebug.info(id), first);
  check(info?.win32 === true, `win32-input-mode negotiated with ConPTY (info: ${JSON.stringify(info)})`);

  await page.click('.pane__viewport');
  const kind = await page.evaluate((id) => window.__lookoutDebug.state().runtime[id]?.shellKind, first);
  await page.keyboard.type('echo lookout-smoke-$(6*7)');
  await page.keyboard.press('Enter');
  check(await waitForText(first, 'lookout-smoke-42'), `typed command runs in ${kind}`);

  // The fresh environment must not pick up the system hive's USERNAME=SYSTEM.
  await page.keyboard.type('echo "user=$env:USERNAME"');
  await page.keyboard.press('Enter');
  check(await waitForText(first, `user=${process.env.USERNAME}`), `shells see the signed-in user (${process.env.USERNAME})`);

  // AltGr characters must reach the shell (Norwegian @ { } via Ctrl+Alt in Chromium).
  await page.keyboard.type('echo a@b{c}');
  await page.keyboard.press('Enter');
  check(await waitForText(first, 'a@b{c}'), 'special characters are typed correctly');

  // cwd tracking
  await page.keyboard.type('cd $env:TEMP');
  await page.keyboard.press('Enter');
  const cwdTracked = await page
    .waitForFunction((id) => /temp/i.test(window.__lookoutDebug.state().runtime[id]?.cwd ?? ''), first, { timeout: 15_000 })
    .then(() => true, () => false);
  check(cwdTracked, 'working directory follows cd (shell integration)');

  // A failing command gets an exit code.
  await page.keyboard.type('cmd /c exit 3');
  await page.keyboard.press('Enter');
  const exitTracked = await page
    .waitForFunction((id) => window.__lookoutDebug.state().runtime[id]?.lastCommand?.exitCode === 3, first, { timeout: 15_000 })
    .then(() => true, () => false);
  check(exitTracked, 'exit codes are tracked per command');

  // Multi-line paste is confirmed unless the shell enabled bracketed paste.
  await page.evaluate(() => navigator.clipboard.writeText('echo paste-one\necho paste-two'));
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(600);
  const pasteState = await page.evaluate((id) => ({ dialog: window.__lookoutDebug.state().ui.dialog?.kind ?? null, bracketed: window.__lookoutDebug.info(id)?.bracketedPaste }), first);
  check(pasteState.bracketed ? pasteState.dialog === null : pasteState.dialog === 'paste', `multi-line paste safety (${JSON.stringify(pasteState)})`);
  if (pasteState.dialog === 'paste') {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    await page.keyboard.press('Escape');
  }
  check((await page.evaluate(() => window.__lookoutDebug.state().ui.dialog)) === null, 'paste dialog cancels with Esc');

  // Closing a pane with a running command asks first.
  await page.waitForTimeout(300);
  await page.keyboard.type('ping -t 127.0.0.1');
  await page.keyboard.press('Enter');
  const running = await page
    .waitForFunction((id) => window.__lookoutDebug.state().runtime[id]?.commandRunning === true, first, { timeout: 15_000 })
    .then(() => true, () => false);
  if (!running) {
    // A stuck modifier once turned this into "^P^I^N^G"; show what the shell actually got.
    const tail = await bufferOf(first).catch(() => '(window closed)');
    console.error(String(tail).split('\n').filter(Boolean).slice(-4).join('\n'));
  }
  check(running, 'running command is detected');
  await page.keyboard.press('Control+Shift+W');
  await page.waitForTimeout(400);
  check((await page.evaluate(() => window.__lookoutDebug.state().ui.dialog?.kind)) === 'confirm', 'closing a busy pane asks for confirmation');
  await page.screenshot({ path: path.join(shots, '02a-confirm-close.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await page.locator('.pane, .tabrow').count()) >= 2, 'cancel keeps the pane');
  await page.click('.pane__viewport');
  await page.keyboard.press('Control+C');
  await page
    .waitForFunction((id) => window.__lookoutDebug.state().runtime[id]?.commandRunning === false, first, { timeout: 10_000 })
    .catch(() => {});
  check(!(await page.evaluate((id) => window.__lookoutDebug.state().runtime[id]?.commandRunning, first)), 'Ctrl+C without a selection interrupts the command');

  // Restart gives a fresh shell (v1 bug: restart only stopped it).
  const sessionBefore = await page.evaluate((id) => window.__lookoutDebug.info(id)?.sessionId, first);
  await page.evaluate(() => window.__lookoutDebug.run('restartPane'));
  const restarted = await page
    .waitForFunction(
      ({ id, before }) => {
        const info = window.__lookoutDebug.info(id);
        return info?.sessionId && info.sessionId !== before && window.__lookoutDebug.state().runtime[id]?.status === 'running';
      },
      { id: first, before: sessionBefore },
      { timeout: 30_000 },
    )
    .then(() => true, () => false);
  check(restarted, 'restart starts a new shell');
  await page.waitForFunction((id) => window.__lookoutDebug.state().runtime[id]?.integrated === true, first, { timeout: 30_000 }).catch(() => {});
  await page.keyboard.type('echo a@b{c} after-restart');
  await page.keyboard.press('Enter');
  await waitForText(first, 'after-restart');

  // Split right via the keymap (Alt+Shift+=), then down via the command API.
  await page.keyboard.press('Alt+Shift+Equal');
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2, null, { timeout: 10_000 }).catch(() => {});
  check((await page.locator('.pane').count()) === 2, 'Alt+Shift+= splits the pane');
  await page.evaluate(() => window.__lookoutDebug.run('splitDown'));
  await page.waitForTimeout(1500);
  check((await page.locator('.pane').count()) === 3, 'split down adds a third pane');
  const second = await focusedPane();
  const inherited = await page
    .waitForFunction((id) => /temp/i.test(window.__lookoutDebug.state().runtime[id]?.cwd ?? ''), second, { timeout: 20_000 })
    .then(() => true, () => false);
  check(inherited, 'new split inherits the folder of the focused pane');
  await page.keyboard.type('Get-ChildItem $env:WINDIR | Select-Object -First 12');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, '02-splits.png') });

  // Second tab
  await page.keyboard.press('Control+Shift+T');
  await page.waitForFunction(() => window.__lookoutDebug.state().tabs.length === 2, null, { timeout: 10_000 }).catch(() => {});
  check((await page.locator('.tabrow').count()) === 2, 'Ctrl+Shift+T opens a new tab');
  await page.waitForTimeout(2500);

  // Command palette
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type('split');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '03-palette.png') });
  await page.keyboard.press('Escape');

  // Find bar
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Shift+F');
  await page.waitForTimeout(300);
  await page.keyboard.type('Windows');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '04-find.png') });
  await page.keyboard.press('Escape');

  // Settings
  await page.keyboard.press('Control+Comma');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '05-settings.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Light theme
  await page.evaluate(async () => {
    const settings = window.__lookoutDebug.state().settings;
    await window.lookout.setSettings({ ...settings, appTheme: 'light', colorScheme: 'Lookout Day' });
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, '06-light.png') });
  await page.evaluate(async () => {
    const settings = window.__lookoutDebug.state().settings;
    await window.lookout.setSettings({ ...settings, appTheme: 'dark', colorScheme: 'Lookout Night' });
  });
  await page.waitForTimeout(800);

  // Dark theme tiles: Settings → Appearance → Slate lifts the window and the terminals together.
  await page.keyboard.press('Control+Comma');
  await page.waitForTimeout(600);
  await page.locator('.settings-nav__item', { hasText: 'Appearance' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('radio', { name: /Slate/ }).click();
  await page.waitForTimeout(1200);
  const themed = await page.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    term: document.querySelector('.pane')?.style.getPropertyValue('--term-bg'),
    scheme: window.__lookoutDebug.state().settings.colorScheme,
    darkTheme: window.__lookoutDebug.state().settings.darkTheme,
  }));
  check(
    themed.bg === '#22272e' && themed.term === '#22272e' && themed.scheme === 'Lookout Slate' && themed.darkTheme === 'slate',
    `choosing the Slate dark theme recolors the window and the terminals (${JSON.stringify(themed)})`,
  );
  await page.screenshot({ path: path.join(shots, '06b-dark-theme.png') });
  await page.getByRole('radio', { name: /Night/ }).click();
  await page.waitForTimeout(800);
  const nightScheme = await page.evaluate(() => window.__lookoutDebug.state().settings.colorScheme);
  check(nightScheme === 'Lookout Night', `switching back to Night restores its terminal scheme (${nightScheme})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Renderer reload keeps shells alive (sessions live in the pty host).
  const beforeReload = await bufferOf(first);
  await page.reload();
  await page.waitForSelector('.xterm', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const afterReload = await page.evaluate(() => {
    const state = window.__lookoutDebug.state();
    return { tabs: state.tabs.length, text: Object.keys(state.tabs[0]?.panes ?? {}).map((id) => window.__lookoutDebug.bufferText(id)).join('\n') };
  });
  check(afterReload.tabs === 2, 'tabs survive a renderer reload');
  check(afterReload.text.includes('a@b{c}') && beforeReload.includes('a@b{c}'), 'scrollback survives a renderer reload (session reattached)');
  await page.screenshot({ path: path.join(shots, '07-after-reload.png') });

  // Quit for real and relaunch with the same profile: tabs, folders and scrollback come back.
  const closed = app.waitForEvent('close', { timeout: 30_000 }).then(() => true, () => false);
  await page.evaluate(() => window.lookout.quit()).catch(() => {});
  check(await closed, 'quit shuts the app down cleanly');

  app = await launchApp();
  const restoredPage = await app.firstWindow();
  await restoredPage.waitForSelector('.xterm', { timeout: 60_000 });
  await restoredPage.waitForTimeout(3000);
  const restored = await restoredPage.evaluate(() => {
    const state = window.__lookoutDebug.state();
    const firstTab = state.tabs[0];
    const paneIds = firstTab ? Object.keys(firstTab.panes) : [];
    return {
      tabs: state.tabs.length,
      panes: paneIds.length,
      text: paneIds.map((id) => window.__lookoutDebug.bufferText(id)).join('\n'),
      cwds: paneIds.map((id) => state.runtime[id]?.cwd ?? ''),
    };
  });
  check(restored.tabs === 2, `tabs are restored after quitting (${restored.tabs})`);
  check(restored.panes === 3, `the split layout is restored (${restored.panes} panes)`);
  check(restored.text.includes('after-restart') && restored.text.includes('restored'), 'scrollback is restored after quitting');
  check(restored.cwds.some((cwd) => /temp/i.test(cwd)), 'panes reopen in their last folder');
  await restoredPage.screenshot({ path: path.join(shots, '08-restored-after-quit.png') });

  // Tear the active tab off into its own window: the live session moves with it.
  const movedPaneText = await restoredPage.evaluate(() => {
    const state = window.__lookoutDebug.state();
    const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
    return window.__lookoutDebug.bufferText(tab.focusedPaneId);
  });
  const secondWindow = app.waitForEvent('window', { timeout: 20_000 });
  await restoredPage.evaluate(() => window.__lookoutDebug.run('moveTabToNewWindow'));
  const torn = await secondWindow.catch(() => null);
  check(Boolean(torn), 'moving a tab opens a new window');
  if (torn) {
    await torn.waitForSelector('.xterm', { timeout: 30_000 });
    await torn.waitForTimeout(1500);
    const moved = await torn.evaluate(() => {
      const state = window.__lookoutDebug.state();
      const tab = state.tabs[0];
      return { tabs: state.tabs.length, panes: Object.keys(tab?.panes ?? {}).length, text: window.__lookoutDebug.bufferText(tab?.focusedPaneId), running: state.runtime[tab?.focusedPaneId]?.status };
    });
    check(moved.tabs === 1 && moved.panes === 3, `the moved tab keeps its panes (${moved.tabs} tab, ${moved.panes} panes)`);
    check(moved.running === 'running' && moved.text.trim().length > 0 && movedPaneText.includes(moved.text.trim().split('\n')[0]), 'the moved tab keeps its live shells and scrollback');
    check(moved.text.includes('restored'), 'restored scrollback survives moving the tab to another window');
    const originalTabs = await restoredPage.evaluate(() => window.__lookoutDebug.state().tabs.length);
    check(originalTabs === 1, 'the original window no longer has the tab');
    await torn.screenshot({ path: path.join(shots, '09-torn-off-window.png') });

    // Drop-down terminal
    const quakeWindow = app.waitForEvent('window', { timeout: 20_000 });
    await torn.evaluate(() => window.lookout.toggleQuake());
    const quake = await quakeWindow.catch(() => null);
    check(Boolean(quake), 'the drop-down terminal opens');
    if (quake) {
      await quake.waitForSelector('.xterm', { timeout: 30_000 });
      await quake.waitForTimeout(2500);
      const kind = await quake.evaluate(() => window.__lookoutDebug.state().windowKind);
      check(kind === 'quake', 'drop-down window is the quake kind');
      await quake.screenshot({ path: path.join(shots, '10-quake.png') });
    }
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await app.close().catch(() => {});
}

console.log(`\nScreenshots: ${shots}`);
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('All smoke checks passed');
