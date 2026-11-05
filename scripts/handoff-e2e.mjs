// End-to-end default-terminal test through the REAL app (run `npm run build` and
// `npm run build:native` first). It temporarily makes Lookout the Windows default
// terminal, opens a console from outside, checks it arrives as a Lookout tab, and
// restores the previous default terminal. Requires explicit consent:
//
//   node scripts/handoff-e2e.mjs --i-consent [screenshotDir]

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

if (!process.argv.includes('--i-consent')) {
  console.error('This test changes HKCU\\Console\\%%Startup for a few seconds. Re-run with --i-consent.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? path.join(os.tmpdir(), 'lookout-handoff-e2e'));
const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
const STARTUP = 'HKCU\\Console\\%%Startup';

function readStartup() {
  const values = {};
  for (const name of ['DelegationConsole', 'DelegationTerminal']) {
    try {
      const out = execFileSync(reg, ['query', STARTUP, '/v', name], { encoding: 'utf8', windowsHide: true });
      values[name] = /REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
    } catch {
      values[name] = null;
    }
  }
  return values;
}

function restoreStartup(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === null) {
      execFileSync(reg, ['delete', STARTUP, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' });
    } else {
      execFileSync(reg, ['add', STARTUP, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, stdio: 'ignore' });
    }
  }
}

const original = readStartup();
console.log(`Original default terminal: ${JSON.stringify(original)}`);

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

const env = { ...process.env, LOOKOUT_TEST: '1', LOOKOUT_TEST_HANDOFF: '1', LOOKOUT_USER_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), 'lookout-handoff-e2e-')) };
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm', { timeout: 60_000 });
  await page.waitForTimeout(1500);

  const enabled = await page.evaluate(() => window.lookout.setIntegration('defaultTerminal', true));
  check(enabled.enabled === true, `Lookout became the default terminal (${JSON.stringify(enabled)})`);

  const tabsBefore = await page.evaluate(() => window.__lookoutDebug.state().tabs.length);
  // A console launched from outside Lookout, with a new visible window: Windows hands it over.
  // Verbatim: Node's quoting would turn `start ""` into `start "\"\""` (a window titled \\).
  spawn(process.env.ComSpec ?? 'cmd.exe', ['/d /c start "" cmd.exe /d /k echo LOOKOUT_E2E_HANDOFF'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();

  const arrived = await page
    .waitForFunction(
      (before) => {
        const state = window.__lookoutDebug.state();
        if (state.tabs.length <= before) return false;
        const tab = state.tabs[state.tabs.length - 1];
        const paneId = tab.focusedPaneId;
        return state.runtime[paneId]?.kind === 'handoff' && window.__lookoutDebug.bufferText(paneId).includes('LOOKOUT_E2E_HANDOFF');
      },
      tabsBefore,
      { timeout: 30_000 },
    )
    .then(() => true, () => false);
  check(arrived, 'the external console opened as a Lookout tab with its output');
  const handoffInfo = await page.evaluate(() => {
    const state = window.__lookoutDebug.state();
    const tab = state.tabs[state.tabs.length - 1];
    return { runtime: state.runtime[tab.focusedPaneId], title: document.querySelector('.tabrow.is-active .tabrow__title')?.textContent };
  });
  console.log(`handoff pane: ${JSON.stringify(handoffInfo)}`);
  check(handoffInfo.title && !/^[\\/]+$/.test(handoffInfo.title), `the handed-off tab has a meaningful title (${handoffInfo.title})`);
  await page.screenshot({ path: path.join(shots, 'handoff-tab.png') }).catch(() => {});

  if (arrived) {
    await page.click('.pane__viewport');
    await page.keyboard.type('echo typed-into-handoff');
    await page.keyboard.press('Enter');
    const typed = await page
      .waitForFunction(() => {
        const state = window.__lookoutDebug.state();
        const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
        return window.__lookoutDebug.bufferText(tab.focusedPaneId).split('typed-into-handoff').length > 2;
      }, null, { timeout: 15_000 })
      .then(() => true, () => false);
    check(typed, 'typing into the handed-off console works');

    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    const closed = await page
      .waitForFunction((before) => window.__lookoutDebug.state().tabs.length === before, tabsBefore, { timeout: 15_000 })
      .then(() => true, () => false);
    check(closed, 'exiting the console closes its tab');
  }

  const disabled = await page.evaluate(() => window.lookout.setIntegration('defaultTerminal', false));
  check(disabled.enabled === false, 'default terminal disabled again');
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  const now = readStartup();
  if (JSON.stringify(now) !== JSON.stringify(original)) {
    console.log('Restoring the original default terminal values directly.');
    restoreStartup(original);
  }
  check(JSON.stringify(readStartup()) === JSON.stringify(original), 'original default terminal restored');
  await app?.close().catch(() => {});
}

process.exit(failures.length ? 1 : 0);
