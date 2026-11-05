// Stress test of the pane split anchors with the way a real hand moves the mouse:
// approach from inside, leave and return, clicks with a pixel or two of jitter,
// press-and-slide-off, right-click + Esc. Every case must leave the anchors working.
//   node scripts/ui-anchors.mjs [screenshotDir]
// Set LOOKOUT_EXE to test a packaged build (for example release\win-unpacked\Lookout.exe);
// otherwise it runs the dev build (`npm run build` first).

import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'lookout-anchors'));
await mkdir(shots, { recursive: true });
const env = { ...process.env, LOOKOUT_TEST: '1', LOOKOUT_USER_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), 'lookout-anchors-')) };
delete env.ELECTRON_RUN_AS_NODE;

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

const launch = process.env.LOOKOUT_EXE
  ? { executablePath: path.resolve(process.env.LOOKOUT_EXE), args: [], cwd: root, env, timeout: 60_000 }
  : { executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60_000 };
const app = await electron.launch(launch);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await page.waitForSelector('.xterm', { timeout: 60_000 });
  await page.waitForTimeout(3000);
  for (const button of await page.locator('.ov-toast__close').all()) {
    await button.click().catch(() => {});
  }

  const paneIds = () => page.evaluate(() => [...document.querySelectorAll('[data-pane-id]')].map((element) => element.dataset.paneId));
  const body = (id) =>
    page.evaluate((paneId) => {
      const rect = document.querySelector(`[data-pane-id="${paneId}"] .pane__body`).getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    }, id);
  const anchorBox = (id, edge) => page.locator(`[data-pane-id="${id}"] .split-anchor--${edge}`).boundingBox({ timeout: 400 }).catch(() => null);
  const visible = async (id, edge) => Boolean(await anchorBox(id, edge));
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const park = async (id) => {
    const rect = await body(id);
    await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2, { steps: 6 });
  };
  /** Moves from the pane center to just inside an edge, like a hand reaching for it. */
  const reach = async (id, edge, inset = 10) => {
    const rect = await body(id);
    await park(id);
    const point = {
      left: { x: rect.x + inset, y: rect.y + rect.h / 2 },
      right: { x: rect.x + rect.w - inset, y: rect.y + rect.h / 2 },
      up: { x: rect.x + rect.w / 2, y: rect.y + inset },
      down: { x: rect.x + rect.w / 2, y: rect.y + rect.h - inset },
    }[edge];
    await page.mouse.move(point.x, point.y, { steps: 10 });
    await page.waitForTimeout(80);
  };
  /** Checks that every edge of a pane still offers its anchor. */
  const allEdgesWork = async (id, label) => {
    const missing = [];
    for (const edge of ['left', 'right', 'up', 'down']) {
      await reach(id, edge);
      if (!(await visible(id, edge))) missing.push(edge);
    }
    check(missing.length === 0, `${label}: every edge still shows its + (missing: ${missing.join(', ') || 'none'})`);
  };

  const [first] = await paneIds();

  // 1. Hovering the spot where the right + sits reveals it (approach from inside, straight at it).
  {
    const rect = await body(first);
    await park(first);
    await page.mouse.move(rect.x + rect.w - 32, rect.y + rect.h / 2, { steps: 12 });
    await page.waitForTimeout(80);
    check(await visible(first, 'right'), 'moving straight onto the right +’s spot reveals it');
  }

  // 2. Leave the + along the edge and come back: it stays, or comes back right away.
  {
    await reach(first, 'right');
    const box = await anchorBox(first, 'right');
    check(Boolean(box), 'reaching the right edge reveals the +');
    if (box) {
      const spot = center(box);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.mouse.move(spot.x - 4, spot.y - 80, { steps: 8 });
      await page.waitForTimeout(80);
      check(await visible(first, 'right'), 'sliding off the + along the edge keeps it visible');
      await page.mouse.move(spot.x, spot.y, { steps: 8 });
      await page.waitForTimeout(80);
      check(await visible(first, 'right'), 'coming back to the + finds it there');
      check(await page.locator(`[data-pane-id="${first}"] .split-preview--right`).isVisible(), 'hovering the + previews the new pane');
      await page.screenshot({ path: path.join(shots, '01-preview.png') });
    }
  }

  // 3. A click with a little jitter (press, move 2 px, release) still splits.
  {
    await reach(first, 'right');
    const box = await anchorBox(first, 'right');
    if (box) {
      const spot = center(box);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.mouse.down();
      await page.mouse.move(spot.x + 2, spot.y + 1, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
    }
    check((await paneIds()).length === 2, 'a click that moves 2 px while pressed still splits');
    const focused = await page.evaluate(() => document.activeElement?.closest('[data-pane-id]')?.dataset.paneId ?? null);
    check(Boolean(focused) && focused !== first, 'the new pane gets keyboard focus, ready to type');
    await page.screenshot({ path: path.join(shots, '02-after-jitter-click.png') });
    await allEdgesWork(first, 'after the jitter click');
  }

  // 4. Press the +, slide off it and release elsewhere: no split, and the + keeps working.
  {
    const before = (await paneIds()).length;
    await reach(first, 'left');
    const box = await anchorBox(first, 'left');
    if (box) {
      const spot = center(box);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.mouse.down();
      await page.mouse.move(spot.x + 120, spot.y + 40, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    }
    check((await paneIds()).length === before, 'pressing the + and releasing elsewhere does not split');
    await allEdgesWork(first, 'after press-and-slide-off');
  }

  // 5. Right-click the + and dismiss the menu with Esc: the + keeps working.
  {
    await reach(first, 'down');
    const box = await anchorBox(first, 'down');
    if (box) {
      const spot = center(box);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.mouse.click(spot.x, spot.y, { button: 'right' });
      await page.waitForTimeout(300);
      check((await page.locator('.ov-menu__item, [role="menuitem"]').count()) > 2, 'right-clicking the + opens the profile menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await allEdgesWork(first, 'after right-click + Esc');
  }

  // 6. Plain clicks keep working, again and again, in every pane.
  for (const [index, edge] of ['down', 'right', 'up'].entries()) {
    const ids = await paneIds();
    const id = ids[index % ids.length];
    const before = ids.length;
    await reach(id, edge);
    const box = await anchorBox(id, edge);
    if (box) {
      const spot = center(box);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.mouse.down();
      await page.mouse.move(spot.x - 1, spot.y + 1);
      await page.mouse.up();
      await page.waitForTimeout(1200);
    }
    check((await paneIds()).length === before + 1, `split ${index + 1}: clicking the ${edge} + adds a pane`);
  }
  await page.screenshot({ path: path.join(shots, '03-final.png') });
  for (const id of await paneIds()) {
    await allEdgesWork(id, `pane ${id.slice(0, 6)}`);
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await app.close().catch(() => {});
}

console.log(`Screenshots: ${shots}`);
console.log(failures.length ? `${failures.length} check(s) failed` : 'All anchor checks passed');
process.exit(failures.length ? 1 : 0);
