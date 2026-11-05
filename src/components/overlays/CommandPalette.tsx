import { GitBranch, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { patchUi, useApp, type PaletteMode } from '../../state/store';
import { cx } from './cx';
import { restoreTerminalFocus } from './focus';
import { buildPaletteItems, EMPTY_HINT, PLACEHOLDER, rankOptionsFor, type PaletteItem } from './palette-items';
import { applyInput, parsePalette, SCOPE_LABEL, SCOPE_PREFIX, serializePalette, type PaletteInput, type PaletteScope } from './palette-model';
import { Chord, Highlight } from './parts';
import { rankSections, type RankedRow } from './rank';

const ROW_HEIGHT = 28;
const LIST_ID = 'ov-palette-list';

function rowId(index: number): string {
  return `ov-palette-row-${index}`;
}

function setInput(next: PaletteInput): void {
  patchUi({ palette: serializePalette(next) });
}

function closePalette(): void {
  patchUi({ palette: null });
}

function runItem(item: PaletteItem): void {
  // Close first so focus can return to the terminal; actions refocus panes themselves.
  closePalette();
  item.run();
}

export function CommandPalette({ palette }: { palette: { mode: PaletteMode; query: string } }) {
  const data = useApp(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      runtime: state.runtime,
      git: state.git,
      settings: state.settings,
      workspaces: state.workspaces,
      recentDirectories: state.recentDirectories,
      homeDir: state.homeDir,
      elevated: state.elevated,
    })),
  );
  const input = parsePalette(palette);
  const { scope, text } = input;
  const hasQuery = Boolean(text.trim());

  const items = useMemo(() => buildPaletteItems(scope, data), [scope, data]);
  const { groups, rows } = useMemo(() => {
    const sections = rankSections(items, text, rankOptionsFor(scope, Boolean(text.trim())));
    const flat: RankedRow<PaletteItem>[] = [];
    const starts: number[] = [];
    for (const section of sections) {
      starts.push(flat.length);
      flat.push(...section.rows);
    }
    return { groups: sections.map((section, index) => ({ ...section, start: starts[index] })), rows: flat };
  }, [items, text, scope]);

  // Selection resets whenever the query or scope changes.
  const selectionKey = `${scope}\u0000${text}`;
  const [selection, setSelection] = useState({ key: selectionKey, index: 0 });
  const active = rows.length ? Math.min(selection.key === selectionKey ? selection.index : 0, rows.length - 1) : -1;
  const select = (index: number) => setSelection({ key: selectionKey, index });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || active < 0) {
      return;
    }
    if (active === 0) {
      list.scrollTop = 0;
      return;
    }
    list.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, selectionKey]);

  // Chromium sends synthetic mousemoves when content moves under a resting pointer
  // (palette opening, keyboard scrolling); only a real pointer move selects.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hover = (index: number, x: number, y: number) => {
    const last = pointer.current;
    pointer.current = { x, y };
    if (!last || (last.x === x && last.y === y)) {
      return;
    }
    if (index !== active) {
      select(index);
    }
  };

  useEffect(() => () => restoreTerminalFocus(), []);

  const pageSize = () => Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const count = rows.length;
    const from = Math.max(active, 0);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (count) {
          select((from + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
        }
        return;
      case 'PageDown':
      case 'PageUp':
        event.preventDefault();
        if (count) {
          select(Math.max(0, Math.min(count - 1, from + (event.key === 'PageDown' ? pageSize() : -pageSize()))));
        }
        return;
      case 'Home':
      case 'End':
        if (event.ctrlKey && count) {
          event.preventDefault();
          select(event.key === 'Home' ? 0 : count - 1);
        }
        return;
      case 'Enter':
        event.preventDefault();
        if (active >= 0) {
          runItem(rows[active].item);
        }
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closePalette();
        return;
      case 'Tab':
        event.preventDefault();
        return;
      case 'Backspace':
        // Ctrl+Backspace drops the scope prefix but keeps the text; Backspace on an empty input does too.
        if (scope !== 'all' && (event.ctrlKey || !text)) {
          event.preventDefault();
          setInput({ scope: 'all', text: event.ctrlKey ? text : '' });
        }
        return;
    }
  };

  const onScrimMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      closePalette();
    }
  };

  const prefix = SCOPE_PREFIX[scope];

  return (
    <div className="ov-scrim ov-scrim--palette" onMouseDown={onScrimMouseDown}>
      <div className="ov-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="ov-palette__head">
          <Search className="ov-palette__search" size={14} strokeWidth={1.75} aria-hidden />
          {scope !== 'all' && (
            <span className="ov-palette__scope">
              {prefix && <span className="mono">{prefix}</span>}
              {SCOPE_LABEL[scope]}
            </span>
          )}
          <input
            className="ov-palette__input"
            autoFocus
            value={text}
            placeholder={PLACEHOLDER[scope]}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? rowId(active) : undefined}
            onChange={(event) => setInput(applyInput(input, event.target.value))}
            onKeyDown={onKeyDown}
          />
        </div>

        <div ref={listRef} id={LIST_ID} className="ov-palette__list" role="listbox" aria-label={SCOPE_LABEL[scope]}>
          {groups.map((group) => (
            <div key={group.title} role="group" aria-label={group.title}>
              <div className="ov-palette__section">{group.title}</div>
              {group.rows.map((row, offset) => {
                const index = group.start + offset;
                return (
                  <PaletteRow
                    key={row.item.id}
                    row={row}
                    index={index}
                    active={index === active}
                    nested={!hasQuery && Boolean(row.item.indent)}
                    onHover={hover}
                  />
                );
              })}
            </div>
          ))}
          {!rows.length && <div className="ov-palette__empty">{items.length ? `No matches for “${text.trim()}”` : EMPTY_HINT[scope]}</div>}
        </div>

        <PaletteFooter scope={scope} />
      </div>
    </div>
  );
}

interface RowProps {
  row: RankedRow<PaletteItem>;
  index: number;
  active: boolean;
  nested: boolean;
  onHover: (index: number, x: number, y: number) => void;
}

function PaletteRow({ row, index, active, nested, onHover }: RowProps) {
  const { item } = row;
  const Icon = item.icon;
  return (
    <div
      id={rowId(index)}
      data-row={index}
      role="option"
      aria-selected={active}
      className={cx('ov-row', active && 'is-active', nested && 'is-nested', item.danger && 'is-danger')}
      onMouseMove={(event) => onHover(index, event.clientX, event.clientY)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => runItem(item)}
    >
      <span className="ov-row__icon" aria-hidden>
        {item.dot !== undefined ? (
          <span className="ov-row__dot" style={item.dot ? { background: item.dot } : undefined} />
        ) : item.glyph ? (
          <span className="ov-row__glyph">{item.glyph}</span>
        ) : Icon ? (
          <Icon size={14} strokeWidth={1.75} />
        ) : null}
      </span>
      <span className={cx('ov-row__label truncate', item.labelMono && 'mono')}>
        <Highlight text={item.label} positions={row.labelPositions} />
      </span>
      {item.detail && (
        <span className={cx('ov-row__detail truncate', item.detailMono && 'mono')}>
          <Highlight text={item.detail} positions={row.detailPositions} />
        </span>
      )}
      <span className="ov-row__meta">
        {item.branch && (
          <span className="ov-branch" title={item.branch}>
            <GitBranch size={11} strokeWidth={1.75} aria-hidden />
            <span className="truncate">{item.branch}</span>
          </span>
        )}
        {item.tag && <span className="ov-row__tag">{item.tag}</span>}
        {item.chord && <Chord chord={item.chord} />}
      </span>
    </div>
  );
}

const PREFIX_HINTS: Array<{ prefix: string; label: string }> = [
  { prefix: '>', label: 'commands' },
  { prefix: '@', label: 'profiles' },
  { prefix: '#', label: 'workspaces' },
  { prefix: ':', label: 'folders' },
];

function PaletteFooter({ scope }: { scope: PaletteScope }) {
  return (
    <div className="ov-palette__foot">
      <span className="ov-hint">
        <kbd className="kbd">↑</kbd>
        <kbd className="kbd">↓</kbd>
        navigate
      </span>
      <span className="ov-hint">
        <kbd className="kbd">↵</kbd>
        run
      </span>
      <span className="ov-hint">
        <kbd className="kbd">Esc</kbd>
        close
      </span>
      <span className="ov-palette__foot-spacer" />
      {scope === 'all' ? (
        PREFIX_HINTS.map((hint) => (
          <span key={hint.prefix} className="ov-hint">
            <kbd className="kbd">{hint.prefix}</kbd>
            {hint.label}
          </span>
        ))
      ) : (
        <span className="ov-hint">
          <kbd className="kbd">Ctrl</kbd>
          <kbd className="kbd">⌫</kbd>
          all results
        </span>
      )}
    </div>
  );
}
