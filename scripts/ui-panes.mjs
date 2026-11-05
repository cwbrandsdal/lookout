// End-to-end test of spatial pane editing with a real mouse (run `npm run build` first):
// edge anchors, split previews, drag to dock/swap/new tab, magnetic dividers.
//   node scripts/ui-panes.mjs [screenshotDir]

import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'lookout-panes'));
await mkdir(shots, { recursive: true });
const env = { ...process.env, LOOKOUT_TEST: '1', LOOKOUT_USER_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), 'lookout-panes-')) };
delete env.ELECTRON_RUN_AS_NODE;

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

const app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60_000 });
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await page.waitForSelector('.xterm', { timeout: 60_000 });
  await page.waitForTimeout(3000);
  // Welcome toasts sit over the bottom-right corner; clear them so the pointer reaches the panes.
  const dismissToasts = async () => {
    for (const button of await page.locator('.ov-toast__close').all()) {
      await button.click().catch(() => {});
    }
  };
  await dismissToasts();

  const rects = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-pane-id]')].map((element) => {
          const rect = element.getBoundingClientRect();
          return [element.dataset.paneId, { x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
        }),
      ),
    );
  const bodyRect = (paneId) =>
    page.evaluate((id) => {
      const rect = document.querySelector(`[data-pane-id="${id}"] .pane__body`).getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    }, paneId);

  // 1. Hover the right edge of the only pane: an anchor appears; hovering it previews; clicking splits right.
  const [first] = Object.keys(await rects());
  let body = await bodyRect(first);
  await page.mouse.move(body.x + body.w - 12, body.y + body.h / 2);
  await page.waitForTimeout(150);
  check(await page.locator('.split-anchor--right').isVisible(), 'moving to the right edge reveals a split anchor');
  const anchor = await page.locator('.split-anchor--right').boundingBox();
  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  await page.waitForTimeout(150);
  check(await page.locator('.split-preview--right').isVisible(), 'hovering the anchor previews the new pane');
  await page.screenshot({ path: path.join(shots, '01-anchor-preview.png') });
  await page.mouse.click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  await page.waitForTimeout(1200);
  let layout = await rects();
  const second = Object.keys(layout).find((id) => id !== first);
  check(Object.keys(layout).length === 2 && second && layout[second].x > layout[first].x, 'clicking it splits to the right');

  // 2. Bottom edge of the new pane: split below.
  body = await bodyRect(second);
  await page.mouse.move(body.x + body.w / 2, body.y + body.h / 2, { steps: 4 });
  await page.mouse.move(body.x + body.w / 2, body.y + body.h - 8, { steps: 6 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, '01b-bottom-anchor.png') });
  const down = await page.locator(`[data-pane-id="${second}"] .split-anchor--down`).boundingBox({ timeout: 3000 }).catch(() => null);
  check(Boolean(down), 'the bottom edge reveals a "split below" anchor');
  if (down) {
    await page.mouse.click(down.x + down.width / 2, down.y + down.height / 2);
    await page.waitForTimeout(1200);
  }
  layout = await rects();
  const third = Object.keys(layout).find((id) => id !== first && id !== second);
  check(Boolean(third) && layout[third].y > layout[second].y && Math.abs(layout[third].x - layout[second].x) < 2, 'clicking it splits below');

  // 3. Right-click an anchor: pick a profile for the new pane.
  body = await bodyRect(first);
  await page.mouse.move(body.x + 10, body.y + body.h / 2);
  await page.waitForTimeout(150);
  const leftAnchor = await page.locator(`[data-pane-id="${first}"] .split-anchor--left`).boundingBox();
  if (leftAnchor) {
    await page.mouse.click(leftAnchor.x + 12, leftAnchor.y + 12, { button: 'right' });
    await page.waitForTimeout(300);
  }
  const menuItems = await page.locator('[role="menuitem"], .ov-menu__item').count();
  check(menuItems > 2, `right-clicking an anchor offers profiles (${menuItems} items)`);
  await page.screenshot({ path: path.join(shots, '02-anchor-profiles.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 4. Drag the third pane by its header onto the left edge of the first: it docks there.
  const header = async (id) => page.locator(`[data-pane-id="${id}"] .pane__header`).boundingBox();
  let from = await header(third);
  layout = await rects();
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 40, { steps: 4 });
  const target = layout[first];
  await page.mouse.move(target.x + 30, target.y + target.h / 2, { steps: 12 });
  await page.waitForTimeout(200);
  check(await page.locator(`[data-pane-id="${first}"] .drop-preview--left`).isVisible(), 'dragging over a pane edge previews docking there');
  check(await page.locator('.drag-ghost').isVisible(), 'a ghost chip follows the pointer');
  await page.screenshot({ path: path.join(shots, '03-drag-dock.png') });
  await page.mouse.up();
  await page.waitForTimeout(800);
  layout = await rects();
  check(layout[third].x < layout[first].x, 'dropping docks the pane on that side');

  // 5. Drag onto the center of another pane: they swap places.
  const before = await rects();
  from = await header(first);
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 30, { steps: 4 });
  const swapTarget = before[second];
  await page.mouse.move(swapTarget.x + swapTarget.w / 2, swapTarget.y + swapTarget.h / 2, { steps: 12 });
  await page.waitForTimeout(200);
  check(await page.locator(`[data-pane-id="${second}"] .drop-preview--center`).isVisible(), 'the center of a pane previews a swap');
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await rects();
  check(Math.abs(after[first].x - before[second].x) < 3 && Math.abs(after[second].x - before[first].x) < 3, 'dropping in the center swaps the panes');

  // 6. Esc cancels a drag.
  const beforeCancel = await rects();
  from = await header(second);
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeCancel[third].x + 20, beforeCancel[third].y + beforeCancel[third].h / 2, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(JSON.stringify(await rects()) === JSON.stringify(beforeCancel), 'Esc cancels a drag without changes');

  // 7. Drag a pane onto the sidebar: it becomes its own tab.
  from = await header(second);
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 40, { steps: 4 });
  await page.mouse.move(110, 400, { steps: 12 });
  await page.waitForTimeout(250);
  check(await page.locator('.tabrow-drop-new.is-target').isVisible(), 'the sidebar offers "new tab" while dragging');
  await page.screenshot({ path: path.join(shots, '04-drag-new-tab.png') });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const tabs = await page.evaluate(() => window.__lookoutDebug.state().tabs.map((tab) => Object.keys(tab.panes).length));
  check(tabs.length === 2 && tabs.includes(1) && tabs.includes(2), `dropping on the sidebar moves the pane to a new tab (${JSON.stringify(tabs)})`);

  // 8. Drag the tab-less pane back onto the first tab's row.
  await page.evaluate(() => window.__lookoutDebug.run('switchToTab', { index: 0 }));
  await page.waitForTimeout(500);
  const firstTabPanes = Object.keys(await rects());
  const dragId = firstTabPanes[0];
  from = await header(dragId);
  const secondRow = await page.locator('.tabrow').nth(1).boundingBox();
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 40, { steps: 4 });
  await page.mouse.move(secondRow.x + 60, secondRow.y + secondRow.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  check(await page.locator('.tabrow.is-pane-target').isVisible(), 'hovering a tab row while dragging highlights it');
  await page.mouse.up();
  await page.waitForTimeout(800);
  const tabsAfter = await page.evaluate(() => window.__lookoutDebug.state().tabs.map((tab) => Object.keys(tab.panes).length));
  check(JSON.stringify([...tabsAfter].sort()) === JSON.stringify([1, 2]), `dropping on a tab row moves the pane into that tab (${JSON.stringify(tabsAfter)})`);

  // 9. Magnetic divider: drag close to the middle and it snaps to exactly ½, showing pane sizes.
  const divider = await page.locator('.divider').first().boundingBox();
  if (divider) {
    const grid = await page.locator('.grid').boundingBox();
    const horizontal = divider.height > divider.width;
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    if (horizontal) {
      await page.mouse.move(grid.x + grid.width * 0.3, divider.y + divider.height / 2, { steps: 6 });
      await page.mouse.move(grid.x + grid.width * 0.506, divider.y + divider.height / 2, { steps: 6 });
    } else {
      await page.mouse.move(divider.x + divider.width / 2, grid.y + grid.height * 0.3, { steps: 6 });
      await page.mouse.move(divider.x + divider.width / 2, grid.y + grid.height * 0.506, { steps: 6 });
    }
    await page.waitForTimeout(250);
    check(await page.locator('.pane__size').first().isVisible(), 'panes show their columns × rows while resizing');
    await page.screenshot({ path: path.join(shots, '05-resize-size.png') });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const sizes = await page.evaluate(() => {
      const state = window.__lookoutDebug.state();
      const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
      return tab.layout.type === 'split' ? tab.layout.sizes : null;
    });
    check(Boolean(sizes) && Math.abs(sizes[0] - 0.5) < 1e-6, `the divider snaps to ½ (${JSON.stringify(sizes)})`);
  }
  await page.screenshot({ path: path.join(shots, '06-final.png') });
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await app.close().catch(() => {});
}

console.log(`Screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
