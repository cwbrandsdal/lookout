import { build, context } from 'esbuild';

const watchMode = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  // main + preload run in Electron; pty-host runs as an Electron utilityProcess.
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
    'pty-host': 'electron/pty-host/host.ts',
  },
  external: ['electron', 'node-pty'],
  format: 'cjs',
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
  outdir: 'dist-electron',
  platform: 'node',
  sourcemap: watchMode ? 'inline' : true,
  target: 'node22',
};

if (watchMode) {
  const ctx = await context(sharedOptions);
  await ctx.watch();
  console.log('Electron sources are being watched...');
  await new Promise(() => {});
} else {
  await build(sharedOptions);
}
