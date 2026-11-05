import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { isLightScheme } from '../../shared/color-schemes';
import type { ColorScheme } from '../../shared/settings';
import { Segmented } from './controls';
import { cx } from './filter';
import { SCHEME_ANSI_KEYS } from './helpers';

type SchemeFilter = 'all' | 'dark' | 'light';

interface SchemePickerProps {
  schemes: readonly ColorScheme[];
  selected: string;
  /** Lowercased names of schemes defined in settings.json (deletable). */
  userSchemes: ReadonlySet<string>;
  onSelect: (name: string) => void;
  onDelete: (name: string) => void;
}

export function SchemePicker({ schemes, selected, userSchemes, onSelect, onDelete }: SchemePickerProps) {
  const [filter, setFilter] = useState<SchemeFilter>('all');
  const visible = useMemo(
    () => schemes.filter((scheme) => filter === 'all' || (filter === 'light') === isLightScheme(scheme)),
    [schemes, filter],
  );
  const selectedKey = selected.toLowerCase();

  return (
    <div className="settings-schemes">
      <div className="settings-schemes__bar">
        <Segmented
          label="Show schemes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
        <span className="faint">{visible.length} schemes</span>
      </div>
      <ul className="settings-schemes__grid" aria-label="Color schemes">
        {visible.map((scheme) => {
          const isSelected = scheme.name.toLowerCase() === selectedKey;
          const isUser = userSchemes.has(scheme.name.toLowerCase());
          return (
            <li key={scheme.name} className="settings-scheme">
              <button
                type="button"
                className={cx('settings-scheme__card', isSelected && 'is-selected')}
                aria-pressed={isSelected}
                aria-label={`${scheme.name}${isSelected ? ' (current)' : ''}`}
                onClick={() => onSelect(scheme.name)}
              >
                <span className="settings-scheme__sample" style={{ background: scheme.background, color: scheme.foreground }} aria-hidden="true">
                  <span style={{ color: scheme.green }}>❯</span> <span style={{ color: scheme.blue }}>~/src</span>{' '}
                  <span style={{ color: scheme.purple }}>main</span> <span style={{ color: scheme.red }}>err</span>
                  <span className="settings-scheme__cursor" style={{ background: scheme.cursorColor }} />
                </span>
                <span className="settings-scheme__swatches" aria-hidden="true">
                  {SCHEME_ANSI_KEYS.map((key) => (
                    <span key={key} style={{ background: scheme[key] }} />
                  ))}
                </span>
                <span className="settings-scheme__name">
                  <span className="truncate">{scheme.name}</span>
                  {isUser ? <span className="settings-scheme__tag">custom</span> : null}
                </span>
              </button>
              {isUser ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger settings-scheme__delete"
                  aria-label={`Delete ${scheme.name}`}
                  title="Delete scheme"
                  onClick={() => onDelete(scheme.name)}
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
