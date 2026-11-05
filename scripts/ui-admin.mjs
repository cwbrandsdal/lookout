// End-to-end test of "Run as administrator" workspaces, without a UAC prompt (run
// `npm run build` first). A normal test instance marks a workspace and opening it
// must ask for the administrator window instead of opening here. A stand-in admin
// instance (LOOKOUT_TEST_ELEVATED) must then copy it from the normal instance's
// state, open it, share its settings, and take later requests as a second instance.
//   node scripts/ui-admin.mjs [screenshotDir]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'lookout-admin'));
await mkdir(shots, { recursive: true });
const electronExe = process.env.LOOKOUT_EXE ? path.resolve(process.env.LOOKOUT_EXE) : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appArgs = process.env.LOOKOUT_EXE ? [] : [root];
const userDir = await mkdtemp(path.join(os.tmpdir(), 'lookout-admin-user-'));
const adminDir = await mkdtemp(path.join(os.tmpdir(), 'lookout-admin-elevated-'));

const baseEnv = { ...process.env, LOOKOUT_TEST: '1' };
delete baseEnv.ELECTRON_RUN_AS_NODE;
const userEnv = { ...baseEnv, LOOKOUT_USER_DATA_DIR: userDir };
const adminEnv = { ...baseEnv, LOOKOUT_USER_DATA_DIR: adminDir, LOOKOUT_TEST_ELEVATED: '1', LOOKOUT_TEST_USER_INSTANCE_DIR: userDir };

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

async function launch(env, args = []) {
  const app = await electron.launch({ executablePath: electronExe, args: [...appArgs, ...args], cwd: root, env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1300, height: 820 }).catch(() => {});
  await page.waitForSelector('.xterm', { timeout: 60_000 });
  await page.waitForTimeout(1500);
  for (const button of await page.locator('.ov-toast__close').all()) await button.click().catch(() => {});
  return { app, page };
}

const state = (page) => page.evaluate(() => window.__lookoutDebug.state());
const menuItems = (page) => page.locator('.ov-menu [role^="menuitem"]').allInnerTexts();

let workspaceId;
let launchArgs;

// 1. Normal window: save a workspace, mark it, and open it.
{
  const { app, page } = await launch(userEnv);
  try {
    await page.evaluate(async () => {
      const settings = window.__lookoutDebug.state().settings;
      await window.lookout.setSettings({ ...settings, appTheme: 'dark', darkTheme: 'slate', colorScheme: 'Lookout Slate' });
    });
    await page.locator('button[title="Save current tab as a workspace"]').click();
    await page.locator('.ov-dialog__form input').fill('Infra');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__lookoutDebug.state().workspaces.length === 1, null, { timeout: 5000 });
    workspaceId = (await state(page)).workspaces[0].id;

    const row = page.locator(`[data-workspace-id="${workspaceId}"]`);
    await row.click({ button: 'right' });
    check((await menuItems(page)).some((text) => /Run as administrator/.test(text)), 'the workspace menu offers "Run as administrator"');
    await page.locator('.ov-menu [role="menuitemcheckbox"]', { hasText: 'Run as administrator' }).click();
    await page.waitForFunction(() => window.__lookoutDebug.state().workspaces[0]?.elevate === true, null, { timeout: 5000 }).catch(() => {});
    check((await state(page)).workspaces[0]?.elevate === true, 'switching it on marks the workspace');
    check(await row.locator('.workspace-row__admin').isVisible(), 'the sidebar row shows a shield');
    await page.screenshot({ path: path.join(shots, '01-marked.png') });

    await row.click({ button: 'right' });
    const items = await menuItems(page);
    check(items.some((text) => /Open as administrator/.test(text)), `the menu now says "Open as administrator" (${items.join(' | ')})`);
    await page.keyboard.press('Escape');

    const tabsBefore = (await state(page)).tabs.length;
    await row.locator('.workspace-row__main').click();
    await page.waitForTimeout(800);
    const launches = await app.evaluate(() => globalThis.__lookoutAdminLaunches ?? []);
    launchArgs = launches.at(-1)?.slice(appArgs.length) ?? [];
    check(JSON.stringify(launchArgs) === JSON.stringify(['open', workspaceId]), `opening it asks for the administrator window (${JSON.stringify(launchArgs)})`);
    check((await state(page)).tabs.length === tabsBefore, 'and does not open it in the normal window');

    // Switching it back off opens it here again.
    await row.click({ button: 'right' });
    await page.locator('.ov-menu [role="menuitemcheckbox"]', { hasText: 'Run as administrator' }).click();
    await page.waitForFunction(() => !window.__lookoutDebug.state().workspaces[0]?.elevate, null, { timeout: 5000 }).catch(() => {});
    await row.locator('.workspace-row__main').click();
    await page.waitForTimeout(800);
    const reopened = await state(page);
    check(reopened.tabs.some((tab) => tab.workspaceId === workspaceId), 'switched off, it opens in the normal window');
    check((await app.evaluate(() => globalThis.__lookoutAdminLaunches.length)) === launches.length, 'without asking for the administrator window');

    // Leave it marked for the admin half.
    await row.click({ button: 'right' });
    await page.locator('.ov-menu [role="menuitemcheckbox"]', { hasText: 'Run as administrator' }).click();
    await page.waitForFunction(() => window.__lookoutDebug.state().workspaces[0]?.elevate === true, null, { timeout: 5000 });
  } finally {
    await app.close();
  }
}

// 2. Stand-in administrator instance, started the way UAC would start it.
{
  const { app, page } = await launch(adminEnv, launchArgs);
  try {
    await page.waitForFunction((id) => window.__lookoutDebug.state().tabs.some((tab) => tab.workspaceId === id), workspaceId, { timeout: 10_000 }).catch(() => {});
    const admin = await state(page);
    check(admin.elevated === true && (await page.locator('.sidebar__admin').isVisible()), 'the stand-in runs as the administrator window');
    check(admin.tabs.length === 1 && admin.tabs[0].workspaceId === workspaceId && admin.tabs[0].title === 'Infra', `it opens the workspace (${admin.tabs.map((tab) => tab.title).join(', ')})`);
    check(admin.workspaces.some((entry) => entry.id === workspaceId && entry.elevate), 'and lists it in its sidebar');
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    check(admin.settings.darkTheme === 'slate' && bg === '#22272e', `it shares the normal window's settings (theme ${admin.settings.darkTheme}, ${bg})`);
    const update = await page.evaluate(() => window.lookout.getUpdateState());
    check(update.phase === 'unsupported' && /normal Lookout window/.test(update.error ?? ''), `it leaves updates to the normal window ("${update.error}")`);
    const marker = await readFile(path.join(adminDir, 'running.pid'), 'utf8').catch(() => '');
    const adminPid = await app.evaluate(() => process.pid);
    check(marker === String(adminPid), `it marks itself running, so the normal window holds updates back (pid ${marker || 'missing'})`);

    await page.locator(`[data-workspace-id="${workspaceId}"]`).click({ button: 'right' });
    const items = await menuItems(page);
    check(items.some((text) => /^Open\b/.test(text)) && !items.some((text) => /administrator/.test(text)), `its menu has no administrator switch (${items.join(' | ')})`);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(shots, '02-admin-window.png') });

    // A workspace marked later in the normal instance, requested while the admin window runs.
    const file = path.join(userDir, 'state.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const late = { ...saved.workspaces[0], id: 'late-workspace', name: 'Late', elevate: true, updatedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify({ ...saved, workspaces: [...saved.workspaces, late] }));
    const second = spawn(electronExe, [...appArgs, 'open', 'late-workspace', '--elevated'], { env: adminEnv, stdio: 'ignore' });
    await new Promise((resolve) => second.on('exit', resolve));
    await page.waitForFunction(() => window.__lookoutDebug.state().tabs.some((tab) => tab.workspaceId === 'late-workspace'), null, { timeout: 10_000 }).catch(() => {});
    const after = await state(page);
    check(after.tabs.some((tab) => tab.workspaceId === 'late-workspace' && tab.title === 'Late'), 'a running administrator window opens a newly marked workspace');
    check(after.workspaces.some((entry) => entry.id === 'late-workspace'), 'and adds it to its sidebar');
    await page.screenshot({ path: path.join(shots, '03-second-request.png') });
  } finally {
    await app.close();
  }
  check(!existsSync(path.join(adminDir, 'running.pid')), 'quitting removes its running marker');
}

console.log(`\nScreenshots: ${shots}`);
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('All administrator workspace checks passed');
