// Entry point of the pty host, an Electron utilityProcess (bundled to
// dist-electron/pty-host.cjs). Main talks to it over `process.parentPort`;
// each window's renderer gets its own MessagePort via `connect-window`.

import type { MessagePortMain } from 'electron';
import * as nodePty from 'node-pty';
import type { HostToMain } from '../../src/shared/host-protocol';
import { FreshEnvironment } from './environment';
import { startHandoffServer } from './handoff-server';
import { PtyHost } from './host-core';
import type { LogLevel, WindowPort } from './host-core';
import { killProcessTree } from './process-tree';
import { buildShellLaunch } from './shell-launch';

function describe(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The pty host must run as an Electron utilityProcess');
}

function postToMain(message: HostToMain): void {
  try {
    parentPort.postMessage(message);
  } catch {
    // Main is gone.
  }
}

function log(level: LogLevel, message: string): void {
  postToMain({ type: 'log', level, message });
}

// One broken session or callback must never take every shell down with it.
process.on('uncaughtException', (error) => log('error', `Uncaught exception: ${describe(error)}`));
process.on('unhandledRejection', (reason) => log('error', `Unhandled rejection: ${describe(reason)}`));

function adaptPort(port: MessagePortMain): WindowPort {
  return {
    post: (message) => port.postMessage(message),
    onMessage: (callback) => {
      port.on('message', (event) => callback(event.data));
    },
    onClose: (callback) => {
      port.on('close', callback);
    },
    close: () => {
      try {
        port.close();
      } catch {
        // Already closed.
      }
    },
  };
}

const environment = new FreshEnvironment({ log });
environment.prime();

const host = new PtyHost({
  postToMain,
  spawn: (file, args, options) => nodePty.spawn(file, args, options),
  buildLaunch: buildShellLaunch,
  startHandoff: startHandoffServer,
  readEnvironment: () => environment.get(),
  killTree: killProcessTree,
  log,
});

parentPort.on('message', (event) => {
  const ports = Array.isArray(event.ports) ? event.ports : [];
  host.handleMainMessage(event.data, ports.map(adaptPort));
  // Listeners are attached now; release messages queued on the ports.
  for (const port of ports) {
    try {
      port.start();
    } catch (error) {
      log('warn', `Starting a window port failed: ${describe(error)}`);
    }
  }
});

host.start();
