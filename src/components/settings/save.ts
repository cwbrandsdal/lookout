import type { LookoutSettings } from '../../shared/settings';
import { getState, pushToast } from '../../state/store';
import { bridge } from './bridge';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Applies `mutate` to a copy of the current settings and saves the result.
 *
 * Saves are serialized and each one copies the store at run time (main broadcasts the
 * saved settings before `setSettings` resolves), so quick successive edits never
 * overwrite each other. Return `false` from `mutate` to skip the save.
 */
export function updateSettings(mutate: (draft: LookoutSettings) => void | boolean): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const draft = structuredClone(getState().settings);
    if (mutate(draft) === false) {
      return false;
    }
    try {
      const { warnings } = await bridge().setSettings(draft);
      if (warnings.length) {
        pushToast({ tone: 'info', title: 'Setting adjusted', body: warnings.slice(0, 3).join('\n') });
      }
      return true;
    } catch (error) {
      pushToast({ tone: 'error', title: 'Could not save settings', body: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
