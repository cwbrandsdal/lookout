import { ChevronDown } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { fontFamily } from '../../terminal/theme';
import { cx } from './filter';
import { isPropoFont } from './helpers';
import { useDebouncedCommit } from './use-debounced';

interface FontPickerProps {
  id?: string;
  value: string;
  fonts: readonly string[] | null;
  onCommit: (face: string) => unknown;
  placeholder?: string;
  /** Empty commits '' (e.g. "use the default font"). */
  allowEmpty?: boolean;
  width?: number | string;
  label?: string;
}

const MAX_OPTIONS = 200;

/** Searchable font combobox: pick an installed family or type any name. */
export function FontPicker({ id, value, fonts, onCommit, placeholder, allowEmpty, width = 240, label }: FontPickerProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const { schedule, flush, cancel } = useDebouncedCommit<string>();
  const listId = `settings-fonts${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const query = (draft ?? '').trim().toLowerCase();
  const options = useMemo(() => {
    const all = fonts ?? [];
    return (query ? all.filter((name) => name.toLowerCase().includes(query)) : all).slice(0, MAX_OPTIONS);
  }, [fonts, query]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const commitSoon = (face: string, immediate: boolean) => {
    if (!face.trim() && !allowEmpty) {
      cancel();
      return;
    }
    schedule(face.trim(), onCommit);
    if (immediate) {
      const current = generation.current;
      void flush().then(() => {
        if (generation.current === current) setDraft(null);
      });
    }
  };

  const choose = (face: string) => {
    generation.current += 1;
    setDraft(face);
    setOpen(false);
    commitSoon(face, true);
  };

  const type = (text: string) => {
    generation.current += 1;
    setDraft(text);
    setOpen(true);
    setActive(0);
    commitSoon(text, false);
  };

  const finish = () => {
    setOpen(false);
    if (draft !== null && !draft.trim() && !allowEmpty) {
      cancel();
      setDraft(null);
      return;
    }
    const current = generation.current;
    void flush().then(() => {
      if (generation.current === current) setDraft(null);
    });
  };

  const moveActive = (delta: number) => {
    if (!options.length) return;
    const next = (activeIndex + delta + options.length) % options.length;
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else finish();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const showList = open && options.length > 0;
  return (
    <span className="settings-combobox" style={{ width }}>
      <input
        ref={input}
        id={id}
        aria-label={label}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="input settings-combobox__input"
        value={draft ?? value}
        placeholder={placeholder}
        onChange={(event) => type(event.target.value)}
        onFocus={() => setActive(Math.max(0, options.indexOf(value)))}
        onBlur={finish}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="settings-combobox__toggle"
        tabIndex={-1}
        aria-label="Show installed fonts"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          input.current?.focus();
          setOpen((current) => !current);
        }}
      >
        <ChevronDown size={13} />
      </button>
      {showList ? (
        <ul ref={list} id={listId} role="listbox" className="settings-combobox__list">
          {options.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cx('settings-combobox__option', index === activeIndex && 'is-active', name === value && 'is-current')}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(name)}
            >
              <span className="truncate" style={{ fontFamily: fontFamily(name) }}>
                {name}
              </span>
              {isPropoFont(name) ? <span className="settings-combobox__tag">proportional</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
