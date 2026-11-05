import { getFocusedPaneId } from '../../state/actions';
import { getState } from '../../state/store';
import { terminals } from '../../terminal/terminal-manager';

/**
 * After an overlay closes, hands focus back to the focused terminal unless
 * something else claimed it in the meantime (an action that focused a new
 * pane, a rename input, another overlay). Runs after actions' own
 * focusPaneSoon (two frames), so it never fights them.
 */
export function restoreTerminalFocus(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) {
        return;
      }
      const { ui } = getState();
      if (ui.palette || ui.dialog || ui.contextMenu || ui.settingsOpen || ui.renamingTabId) {
        return;
      }
      const paneId = getFocusedPaneId();
      if (paneId) {
        terminals.focus(paneId);
      }
    }),
  );
}
