import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import waitOn from 'wait-on';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const devPort = process.env.LOOKOUT_DEV_PORT ?? '5173';
const devServerUrl = `http://localhost:${devPort}`;

await waitOn({
  resources: [`tcp:${devPort}`, 'dist-electron/main.cjs', 'dist-electron/preload.cjs'],
});

const electronBinary = process.platform === 'win32'
  ? path.join(projectRoot, 'node_modules/electron/dist/electron.exe')
  : path.join(projectRoot, 'node_modules/.bin/electron');

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
