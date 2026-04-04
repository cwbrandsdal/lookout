import { useState } from 'react';
import { FolderKanban, Minus, Plus, Settings2, Square, X } from 'lucide-react';

import type { ProjectSpace } from '../types/app';

interface TabStripProps {
  spaces: ProjectSpace[];
  activeSpaceId: string | null;
  onSelect: (spaceId: string) => void;
  onCreate: () => void;
  onClose: (spaceId: string) => void;
  onRename: (spaceId: string, name: string) => void;
  onConfigure: (spaceId: string) => void;
  onOpenSettings: () => void;
}

export function TabStrip({
  spaces,
  activeSpaceId,
  onSelect,
  onCreate,
  onClose,
  onRename,
  onConfigure,
  onOpenSettings,
}: TabStripProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  return (
    <header className="tab-strip">
      <div className="brand-pill no-drag">
        <FolderKanban size={16} />
        <span>Lookout</span>
      </div>

      <button className="tab-chip__icon tab-strip__settings no-drag" onClick={onOpenSettings} type="button">
        <Settings2 size={14} />
      </button>

      <div className="tab-strip__track no-drag">
        {spaces.map((space) => {
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
    </header>
  );
}
