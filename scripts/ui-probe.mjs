// Debug helper: launch the built app, wait, screenshot, and dump element boxes.
//   node scripts/ui-probe.mjs <out.png> [waitMs]
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'lookout-probe.png'));
const waitMs = Number(process.argv[3] ?? 6000);
const env = { ...process.env, LOOKOUT_TEST: '1', LOOKOUT_USER_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), 'lookout-probe-')) };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env });
const page = await app.firstWindow();
page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => console.log(`[pageerror] ${error.stack ?? error.message}`));
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
const boxes = await page.evaluate(() =>
  ['.shell', '.sidebar', '.shell__main', '.topbar', '.shell__stage', '.grid', '.pane', '.pane__body', '.pane__viewport', '.xterm-host', '.xterm', '.xterm-screen'].map((selector) => {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    return `${selector}: ${rect ? `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}` : 'missing'}`;
  }),
);
console.log(boxes.join('\n'));
console.log(await page.evaluate(() => JSON.stringify(window.__lookoutDebug ? Object.values(window.__lookoutDebug.state().runtime) : 'no debug')));
await app.close();
