import { useShallow } from 'zustand/react/shallow';

import { profileGlyph } from './ui-helpers';
import { findProfile, paneTitle, tabOfPane, tabTitle } from '../state/actions';
import { useApp, type PaneDropTarget } from '../state/store';

const ZONE_TEXT = { left: 'Dock left', right: 'Dock right', up: 'Dock above', down: 'Dock below', center: 'Swap places' } as const;

function describe(target: PaneDropTarget | null): string {
  if (!target) {
    return 'Drop on a pane, a tab, or outside the window';
  }
  switch (target.kind) {
    case 'pane':
      return ZONE_TEXT[target.zone];
    case 'tab': {
      const tab = useApp.getState().tabs.find((entry) => entry.id === target.tabId);
      return `Move to “${tab ? tabTitle(tab) : 'tab'}”`;
    }
    case 'newTab':
      return 'Open in a new tab';
    case 'newWindow':
      return 'Open in a new window';
  }
}

/** The chip that follows the pointer while a pane is being dragged. */
export function PaneDragLayer() {
  const drag = useApp(useShallow((state) => state.ui.paneDrag));
  if (!drag) {
    return null;
  }

  const spec = tabOfPane(drag.paneId)?.panes[drag.paneId];
  const profile = findProfile(spec?.profileId);
  const x = Math.min(drag.x + 16, window.innerWidth - 260);
  const y = Math.min(drag.y + 18, window.innerHeight - 52);

  return (
    <div className={`drag-ghost ${drag.target ? 'has-target' : ''}`} style={{ left: Math.max(4, x), top: Math.max(4, y) }}>
      <span className="drag-ghost__glyph mono">{profile.icon ?? profileGlyph(profile.shellKind)}</span>
      <span className="drag-ghost__title truncate">{paneTitle(drag.paneId)}</span>
      <span className="drag-ghost__hint">{describe(drag.target)}</span>
    </div>
  );
}
