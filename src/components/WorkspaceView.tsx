import { useMemo, useState } from 'react';
import { GripVertical, Plus, Settings2 } from 'lucide-react';

import { buildLayoutTreeFromTemplate, getLayoutTemplate, type LayoutEdge, type LayoutNode, type ProjectSpace } from '../types/app';
import { useAppStore } from '../store/useAppStore';
import { TerminalPane } from './TerminalPane';

interface WorkspaceViewProps {
  space: ProjectSpace;
}

export function WorkspaceView({ space }: WorkspaceViewProps) {
  const openEditConfigurator = useAppStore((state) => state.openEditConfigurator);
  const addPaneToSpace = useAppStore((state) => state.addPaneToSpace);
  const splitPane = useAppStore((state) => state.splitPane);
  const removePane = useAppStore((state) => state.removePane);
  const movePaneToEdge = useAppStore((state) => state.movePaneToEdge);
  const layout = getLayoutTemplate(space.layoutTemplateId);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const [dropTargetEdge, setDropTargetEdge] = useState<LayoutEdge | null>(null);

  const paneMap = useMemo(() => new Map(space.paneDefinitions.map((pane) => [pane.id, pane])), [space.paneDefinitions]);
  const layoutTree = useMemo(
    () => space.layoutTree ?? buildLayoutTreeFromTemplate(space.layoutTemplateId, space.paneDefinitions.map((pane) => pane.id)),
    [space.layoutTemplateId, space.layoutTree, space.paneDefinitions],
  );

  function handleDrop(targetPaneId: string) {
    if (!draggedPaneId || draggedPaneId === targetPaneId) {
      setDraggedPaneId(null);
      setDropTargetPaneId(null);
      setDropTargetEdge(null);
      return;
    }

    useAppStore.getState().reorderPanes(space.id, draggedPaneId, targetPaneId);
    setDraggedPaneId(null);
    setDropTargetPaneId(null);
    setDropTargetEdge(null);
  }

  function handleEdgeDrop(edge: LayoutEdge) {
    if (!draggedPaneId) {
      setDropTargetEdge(null);
      return;
    }

    movePaneToEdge(space.id, draggedPaneId, edge);
    setDraggedPaneId(null);
    setDropTargetPaneId(null);
    setDropTargetEdge(null);
  }

  return (
    <section className="workspace">
      <div className="workspace__toolbar">
        <div className="workspace__toolbar-copy">
          <span>{space.displayName}</span>
          <span>{space.rootPath}</span>
        </div>
        <div className="workspace__toolbar-actions">
          <span className="workspace__toolbar-meta">
            {space.layoutTree ? 'Custom split layout' : layout.name} | {space.paneDefinitions.length} panes
          </span>
          <button className="button button--ghost button--compact" onClick={() => void addPaneToSpace(space.id)} type="button">
            <Plus size={14} />
            Add Pane
          </button>
          <button className="button button--ghost button--compact" onClick={() => openEditConfigurator(space.id)} type="button">
            <Settings2 size={14} />
            Configure
          </button>
        </div>
      </div>

      <div className="workspace__grid workspace__grid--split workspace__grid--edge-drop">
        {layoutTree ? (
          <SplitLayoutNodeView
            draggedPaneId={draggedPaneId}
            dropTargetPaneId={dropTargetPaneId}
            layoutNode={layoutTree}
            onDragEnd={() => {
              setDraggedPaneId(null);
              setDropTargetPaneId(null);
              setDropTargetEdge(null);
            }}
            onDragOver={setDropTargetPaneId}
            onDragStart={setDraggedPaneId}
            onDrop={handleDrop}
            onRemovePane={(paneId) => void removePane(space.id, paneId)}
            onSplitPane={(paneId, direction) => void splitPane(space.id, paneId, direction)}
            paneMap={paneMap}
            space={space}
          />
        ) : null}

        {draggedPaneId ? (
          <>
            <EdgeDropZone edge="left" isActive={dropTargetEdge === 'left'} onDrop={handleEdgeDrop} onHover={setDropTargetEdge} />
            <EdgeDropZone edge="right" isActive={dropTargetEdge === 'right'} onDrop={handleEdgeDrop} onHover={setDropTargetEdge} />
            <EdgeDropZone edge="top" isActive={dropTargetEdge === 'top'} onDrop={handleEdgeDrop} onHover={setDropTargetEdge} />
            <EdgeDropZone edge="bottom" isActive={dropTargetEdge === 'bottom'} onDrop={handleEdgeDrop} onHover={setDropTargetEdge} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function SplitLayoutNodeView({
  layoutNode,
  space,
  paneMap,
  draggedPaneId,
  dropTargetPaneId,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onSplitPane,
  onRemovePane,
}: {
  layoutNode: LayoutNode;
  space: ProjectSpace;
  paneMap: Map<string, ProjectSpace['paneDefinitions'][number]>;
  draggedPaneId: string | null;
  dropTargetPaneId: string | null;
  onDragStart: (paneId: string) => void;
  onDragEnd: () => void;
  onDragOver: (paneId: string) => void;
  onDrop: (paneId: string) => void;
  onSplitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onRemovePane: (paneId: string) => void;
}) {
  if (layoutNode.type === 'leaf') {
    const pane = paneMap.get(layoutNode.paneId);
    if (!pane) {
      return null;
    }

    return (
      <TerminalPane
        dragHandleIcon={GripVertical}
        isDragging={draggedPaneId === pane.id}
        isDropTarget={dropTargetPaneId === pane.id}
        key={pane.id}
        onDragEnd={onDragEnd}
        onDragOver={() => onDragOver(pane.id)}
        onDragStart={() => onDragStart(pane.id)}
        onDrop={() => onDrop(pane.id)}
        onRemovePane={space.paneDefinitions.length > 1 ? () => onRemovePane(pane.id) : undefined}
        onSplitHorizontal={() => onSplitPane(pane.id, 'horizontal')}
        onSplitVertical={() => onSplitPane(pane.id, 'vertical')}
        pane={pane}
        space={space}
      />
    );
  }

  return (
    <div className={`split-layout split-layout--${layoutNode.direction}`}>
      <div className="split-layout__pane">
        <SplitLayoutNodeView
          draggedPaneId={draggedPaneId}
          dropTargetPaneId={dropTargetPaneId}
          layoutNode={layoutNode.children[0]}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDragStart={onDragStart}
          onDrop={onDrop}
          onRemovePane={onRemovePane}
          onSplitPane={onSplitPane}
          paneMap={paneMap}
          space={space}
        />
      </div>
      <div className="split-layout__pane">
        <SplitLayoutNodeView
          draggedPaneId={draggedPaneId}
          dropTargetPaneId={dropTargetPaneId}
          layoutNode={layoutNode.children[1]}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDragStart={onDragStart}
          onDrop={onDrop}
          onRemovePane={onRemovePane}
          onSplitPane={onSplitPane}
          paneMap={paneMap}
          space={space}
        />
      </div>
    </div>
  );
}

function EdgeDropZone({
  edge,
  isActive,
  onDrop,
  onHover,
}: {
  edge: LayoutEdge;
  isActive: boolean;
  onDrop: (edge: LayoutEdge) => void;
  onHover: (edge: LayoutEdge | null) => void;
}) {
  return (
    <div
      className={`workspace-edge-drop workspace-edge-drop--${edge} ${isActive ? 'is-active' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        onHover(edge);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onHover(edge);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(edge);
      }}
    >
      <span>{edge}</span>
    </div>
  );
}
