import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, MoreHorizontal, Pin, Plus, Search, Settings2, Square, X } from 'lucide-react';

import lookoutLogo from '../assets/lookout-app-icon.png';
import type { ProjectSpace } from '../types/app';

interface TabStripProps {
  spaces: ProjectSpace[];
  activeSpaceId: string | null;
  showPinnedTabsOnly: boolean;
  onSelect: (spaceId: string) => void;
  onCreate: () => void;
  onClose: (spaceId: string) => void;
  onRename: (spaceId: string, name: string) => void;
  onConfigure: (spaceId: string) => void;
  onTogglePinned: (spaceId: string) => void;
  onOpenSwitcher: () => void;
  onOpenSettings: () => void;
}

export function TabStrip({
  spaces,
  activeSpaceId,
  showPinnedTabsOnly,
  onSelect,
  onCreate,
  onClose,
  onRename,
  onConfigure,
  onTogglePinned,
  onOpenSwitcher,
  onOpenSettings,
}: TabStripProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const [overflowMenuStyle, setOverflowMenuStyle] = useState<{ left: number; top: number; width: number } | null>(null);

  const visibleSpaces = useMemo(() => {
    if (!showPinnedTabsOnly) {
      return spaces;
    }

    return spaces.filter((space) => space.pinned || space.id === activeSpaceId);
  }, [activeSpaceId, showPinnedTabsOnly, spaces]);

  const overflowSpaces = useMemo(() => {
    const visibleSpaceIds = new Set(visibleSpaces.map((space) => space.id));
    return spaces
      .filter((space) => !visibleSpaceIds.has(space.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [spaces, visibleSpaces]);

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }

    const syncMenuPosition = () => {
      const rect = overflowButtonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const width = Math.min(420, Math.max(window.innerWidth - 24, 260));
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      const top = rect.bottom + 8;
      setOverflowMenuStyle({ left, top, width });
    };

    syncMenuPosition();
    window.addEventListener('resize', syncMenuPosition);
    window.addEventListener('scroll', syncMenuPosition, true);

    return () => {
      window.removeEventListener('resize', syncMenuPosition);
      window.removeEventListener('scroll', syncMenuPosition, true);
    };
  }, [overflowOpen]);

  return (
    <header className="tab-strip">
      <div className="brand-mark no-drag">
        <img alt="" aria-hidden="true" className="brand-mark__image" src={lookoutLogo} />
      </div>

      <div className="tab-strip__controls no-drag">
        <button className="tab-chip__icon tab-strip__control" onClick={onOpenSwitcher} title="Quick switch (Ctrl+K)" type="button">
          <Search size={14} />
        </button>

        <button className="tab-chip__icon tab-strip__control" onClick={onOpenSettings} title="Settings" type="button">
          <Settings2 size={14} />
        </button>
      </div>

      <div className="tab-strip__track no-drag">
        {visibleSpaces.map((space) => {
          const isActive = activeSpaceId === space.id;
          return (
            <div
              key={space.id}
              className={`tab-chip no-drag ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelect(space.id)}
              onDoubleClick={() => {
                setEditingId(space.id);
                setEditingName(space.displayName);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(space.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="tab-chip__content">
                {editingId === space.id ? (
                  <input
                    autoFocus
                    className="tab-chip__input"
                    onBlur={() => {
                      if (editingName.trim()) {
                        onRename(space.id, editingName);
                      }
                      setEditingId(null);
                      setEditingName('');
                    }}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onRename(space.id, editingName);
                        setEditingId(null);
                        setEditingName('');
                      }
                      if (event.key === 'Escape') {
                        setEditingId(null);
                        setEditingName('');
                      }
                    }}
                    value={editingName}
                  />
                ) : (
                  <>
                    <span className="tab-chip__label">{space.displayName}</span>
                    <span className="tab-chip__badge">{space.paneDefinitions.length}</span>
                  </>
                )}
              </div>

              <div className="tab-chip__actions">
                <span className="tab-chip__path">{space.rootPath}</span>
                <button
                  className={`tab-chip__icon ${space.pinned ? 'is-active' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinned(space.id);
                  }}
                  title={space.pinned ? 'Unpin from tab bar' : 'Pin to tab bar'}
                  type="button"
                >
                  <Pin size={14} />
                </button>
                <button
                  className="tab-chip__icon"
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfigure(space.id);
                  }}
                  type="button"
                >
                  <Settings2 size={14} />
                </button>
                <button
                  className="tab-chip__icon"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(space.id);
                  }}
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          );
        })}

        {overflowSpaces.length ? (
          <div className="tab-overflow">
            <button
              ref={overflowButtonRef}
              className="tab-chip tab-chip--overflow no-drag"
              onClick={() => setOverflowOpen((current) => !current)}
              type="button"
            >
              <MoreHorizontal size={16} />
              <span>More</span>
              <span className="tab-chip__badge">{overflowSpaces.length}</span>
            </button>

          </div>
        ) : null}

        <button className="tab-chip tab-chip--create no-drag" onClick={onCreate} type="button">
          <Plus size={16} />
          <span>Project Space</span>
        </button>
      </div>

      <div className="tab-strip__drag-fill" />

      <div className="window-controls no-drag">
        <button className="window-control-button" onClick={() => void window.lookout.minimizeWindow()} type="button">
          <Minus size={14} />
        </button>
        <button className="window-control-button" onClick={() => void window.lookout.toggleMaximizeWindow()} type="button">
          <Square size={11} />
        </button>
        <button className="window-control-button window-control-button--close" onClick={() => void window.lookout.closeWindow()} type="button">
          <X size={14} />
        </button>
      </div>

      {overflowOpen && overflowMenuStyle
        ? createPortal(
            <div className="tab-overflow-overlay no-drag" onMouseDown={() => setOverflowOpen(false)}>
              <div
                className="tab-overflow__menu glass-card"
                onMouseDown={(event) => event.stopPropagation()}
                style={overflowMenuStyle}
              >
                {overflowSpaces.map((space) => (
                  <div key={space.id} className="tab-overflow__row">
                    <button
                      className="tab-overflow__entry"
                      onClick={() => {
                        onSelect(space.id);
                        setOverflowOpen(false);
                      }}
                      type="button"
                    >
                      <span className="tab-overflow__label-row">
                        <span className="tab-overflow__label">{space.displayName}</span>
                        {space.pinned ? <span className="tab-overflow__pill">Pinned</span> : null}
                      </span>
                      <span className="tab-overflow__path">{space.rootPath}</span>
                    </button>

                    <div className="tab-overflow__actions">
                      <button
                        className={`tab-chip__icon ${space.pinned ? 'is-active' : ''}`}
                        onClick={() => onTogglePinned(space.id)}
                        title={space.pinned ? 'Unpin from tab bar' : 'Pin to tab bar'}
                        type="button"
                      >
                        <Pin size={14} />
                      </button>
                      <button
                        className="tab-chip__icon"
                        onClick={() => onClose(space.id)}
                        title="Close space"
                        type="button"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </header>
  );
}
