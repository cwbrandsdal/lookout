import { Check, ChevronRight } from 'lucide-react';
import { createElement, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { patchUi, type ContextMenuState } from '../../state/store';
import { cx } from './cx';
import { restoreTerminalFocus } from './focus';
import { resolveIcon } from './icons';
import type { OverlayMenuItem } from './menus';
import { placeMenu, placeSubmenu } from './position';

/** Delay before hovering a sibling closes an open submenu (lets the pointer travel diagonally). */
const SUBMENU_GRACE_MS = 160;

function closeMenu(): void {
  patchUi({ contextMenu: null });
}

function isSelectable(item: OverlayMenuItem | undefined): item is OverlayMenuItem {
  return Boolean(item && !item.separator && !item.disabled);
}

/** Next selectable index from `from` in `delta` direction, wrapping; -1 when nothing is selectable. */
function step(items: OverlayMenuItem[], from: number, delta: 1 | -1): number {
  const count = items.length;
  let index = from;
  for (let tries = 0; tries < count; tries += 1) {
    index = index < 0 ? (delta > 0 ? 0 : count - 1) : (index + delta + count) % count;
    if (isSelectable(items[index])) {
      return index;
    }
  }
  return -1;
}

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * `path[level]` is the active index in each open panel (-1 = none); a panel
 * at level L + 1 is open when `path[L]` points at an item with a submenu.
 */
export function ContextMenu({ menu }: { menu: ContextMenuState }) {
  const [path, setPath] = useState<number[]>([-1]);
  const layerRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);

  const levels: OverlayMenuItem[][] = [menu.items as OverlayMenuItem[]];
  for (let level = 1; level < path.length; level += 1) {
    const submenu = levels[level - 1][path[level - 1]]?.submenu;
    if (!submenu?.length) {
      break;
    }
    levels.push(submenu);
  }

  const cancelHover = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const activate = (level: number, index: number) => {
    const item = levels[level]?.[index];
    if (!isSelectable(item)) {
      return;
    }
    if (item.submenu?.length) {
      setPath([...path.slice(0, level), index, step(item.submenu, -1, 1)]);
      return;
    }
    closeMenu();
    item.run?.();
  };

  const hover = (level: number, index: number) => {
    cancelHover();
    const item = levels[level][index];
    const base = path.slice(0, level);
    const next = !isSelectable(item) ? [...base, -1] : item.submenu?.length ? [...base, index, -1] : [...base, index];
    if (samePath(next, path) || (path[level] === index && path.length > level + 1)) {
      return;
    }
    if (path.length > level + 1) {
      hoverTimer.current = window.setTimeout(() => setPath(next), SUBMENU_GRACE_MS);
      return;
    }
    setPath(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const level = levels.length - 1;
    const items = levels[level];
    const current = path[level] ?? -1;
    const setActive = (index: number) => setPath([...path.slice(0, level), index]);
    cancelHover();

    switch (event.key) {
      case 'ArrowDown':
        setActive(step(items, current, 1));
        break;
      case 'ArrowUp':
        setActive(step(items, current, -1));
        break;
      case 'Home':
        setActive(step(items, -1, 1));
        break;
      case 'End':
        setActive(step(items, -1, -1));
        break;
      case 'ArrowRight':
        if (items[current]?.submenu?.length) {
          activate(level, current);
        }
        break;
      case 'ArrowLeft':
        if (level > 0) {
          setPath(path.slice(0, level));
        }
        break;
      case 'Escape':
        if (level > 0) {
          setPath(path.slice(0, level));
        } else {
          closeMenu();
        }
        break;
      case 'Enter':
      case ' ':
        if (current >= 0) {
          activate(level, current);
        }
        break;
      case 'Tab':
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        // Type-ahead: next item whose label starts with the key.
        const key = event.key.toLowerCase();
        for (let offset = 1; offset <= items.length; offset += 1) {
          const index = (Math.max(current, -1) + offset + items.length) % items.length;
          if (isSelectable(items[index]) && items[index].label?.toLowerCase().startsWith(key)) {
            setActive(index);
            break;
          }
        }
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Place every open panel: the root at the click point, submenus beside their row.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) {
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const panels = [...layer.querySelectorAll<HTMLElement>(':scope > .ov-menu')];
    panels.forEach((panel, level) => {
      const size = { width: panel.offsetWidth, height: panel.offsetHeight };
      let point = placeMenu({ x: menu.x, y: menu.y }, size, viewport);
      if (level > 0) {
        const parent = panels[level - 1];
        const row = parent.querySelector<HTMLElement>(`[data-index="${path[level - 1]}"]`);
        if (!row) {
          return;
        }
        point = placeSubmenu(parent.getBoundingClientRect(), row.getBoundingClientRect(), size, viewport);
      }
      panel.style.left = `${Math.round(point.x)}px`;
      panel.style.top = `${Math.round(point.y)}px`;
      panel.style.visibility = 'visible';
    });
  });

  useEffect(() => {
    const layer = layerRef.current;
    const claimFocus = () => {
      if (layer && !layer.contains(document.activeElement)) {
        layer.focus({ preventScroll: true });
      }
    };
    claimFocus();
    // The terminal may grab focus back right after the right-click.
    const frame = requestAnimationFrame(claimFocus);

    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !layer?.contains(event.target)) {
        closeMenu();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      restoreTerminalFocus();
    };
  }, []);

  return (
    <div ref={layerRef} className="ov-menu-layer" tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
      {levels.map((items, level) => (
        <div key={level} className="ov-menu" role="menu" data-level={level} onMouseEnter={cancelHover}>
          {items.map((item, index) =>
            item.separator ? (
              <div key={index} className="ov-menu__sep" role="separator" />
            ) : (
              <MenuRow
                key={index}
                item={item}
                index={index}
                active={path[level] === index}
                expanded={path.length > level + 1 && path[level] === index}
                onHover={() => hover(level, index)}
                onActivate={() => activate(level, index)}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

interface MenuRowProps {
  item: OverlayMenuItem;
  index: number;
  active: boolean;
  expanded: boolean;
  onHover: () => void;
  onActivate: () => void;
}

function MenuRow({ item, index, active, expanded, onHover, onActivate }: MenuRowProps) {
  const Icon = resolveIcon(item.icon);
  const hasSubmenu = Boolean(item.submenu?.length);
  return (
    <div
      role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.checked}
      aria-disabled={item.disabled || undefined}
      aria-haspopup={hasSubmenu ? 'menu' : undefined}
      aria-expanded={hasSubmenu ? expanded : undefined}
      data-index={index}
      className={cx('ov-menu__item', active && 'is-active', item.disabled && 'is-disabled', item.danger && 'is-danger')}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <span className="ov-menu__icon" aria-hidden>
        {item.swatch ? (
          <span className="ov-swatch" style={{ background: item.swatch }} />
        ) : item.glyph ? (
          <span className="ov-menu__glyph">{item.glyph}</span>
        ) : Icon ? (
          // createElement: the icon is looked up from a static table, not created here.
          createElement(Icon, { size: 14, strokeWidth: 1.75 })
        ) : null}
      </span>
      <span className="ov-menu__label truncate">{item.label}</span>
      {item.checked && <Check className="ov-menu__check" size={13} strokeWidth={2} aria-hidden />}
      {item.hint && <span className="ov-menu__hint">{item.hint}</span>}
      {hasSubmenu && <ChevronRight className="ov-menu__chevron" size={13} strokeWidth={1.75} aria-hidden />}
    </div>
  );
}
