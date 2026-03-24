const { app } = require('electron');

async function main() {
  await app.whenReady();
  const nodePty = require('node-pty');
  console.log(`node-pty-loaded:${typeof nodePty.spawn}`);
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
