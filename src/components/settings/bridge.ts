import type { LookoutBridge } from '../../shared/ipc';

/** `window.lookout`, typed as the v2 bridge regardless of the global declaration in use. */
export function bridge(): LookoutBridge {
  return (window as unknown as { lookout: LookoutBridge }).lookout;
}
