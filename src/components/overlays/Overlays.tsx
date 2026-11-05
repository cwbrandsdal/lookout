// Overlay layer: command palette, context menus, dialogs, toasts and the link
// tooltip. Rendered once at the app root, after everything else.

import { useEffect, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useApp, type ContextMenuState, type DialogState } from '../../state/store';
import { CommandPalette } from './CommandPalette';
import { ContextMenu } from './ContextMenu';
import { DialogHost } from './Dialogs';
import { LinkHint } from './LinkHint';
import { openPaneMenu } from './menus';
import { Toasts } from './Toasts';

/** Remount (fresh selection / position) whenever a different menu opens. */
function menuKey(menu: ContextMenuState): string {
  return `${menu.x}:${menu.y}:${menu.items.map((item) => (item.separator ? '-' : item.label)).join('|')}`;
}

/** Remount (fresh input state) whenever a different dialog opens. */
function dialogKey(dialog: DialogState): string {
  switch (dialog.kind) {
    case 'confirm':
      return `confirm:${dialog.title}:${dialog.message}`;
    case 'paste':
      return `paste:${dialog.paneId}:${dialog.text.length}`;
    case 'prompt':
      return `prompt:${dialog.title}:${dialog.initial}`;
  }
}

export function Overlays(): JSX.Element {
  const { palette, contextMenu, dialog, toasts } = useApp(
    useShallow((state) => ({
      palette: state.ui.palette,
      contextMenu: state.ui.contextMenu,
      dialog: state.ui.dialog,
      toasts: state.ui.toasts,
    })),
  );

  useEffect(() => {
    const onPaneMenu = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId: string; x: number; y: number } | undefined>).detail;
      if (detail?.paneId) {
        openPaneMenu(detail.paneId, detail.x, detail.y);
      }
    };
    window.addEventListener('lookout:pane-menu', onPaneMenu);
    return () => window.removeEventListener('lookout:pane-menu', onPaneMenu);
  }, []);

  return (
    <>
      {palette && <CommandPalette palette={palette} />}
      {dialog && <DialogHost key={dialogKey(dialog)} dialog={dialog} />}
      {contextMenu && <ContextMenu key={menuKey(contextMenu)} menu={contextMenu} />}
      <Toasts toasts={toasts} />
      <LinkHint />
    </>
  );
}
