import type { LookoutBridge } from '../shared/ipc';

declare global {
  interface Window {
    lookout: LookoutBridge;
  }
}

export {};
