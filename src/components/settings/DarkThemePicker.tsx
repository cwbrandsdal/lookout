import { findScheme } from '../../shared/color-schemes';
import { DARK_THEME_INFO, DARK_THEMES, type DarkTheme } from '../../shared/themes';
import { cx } from './filter';

interface DarkThemePickerProps {
  id: string;
  value: DarkTheme;
  onChange: (theme: DarkTheme) => void;
}

/** One tile per dark variant: a miniature window (sidebar, title strip, terminal) in that theme. */
export function DarkThemePicker({ id, value, onChange }: DarkThemePickerProps) {
  return (
    <div className="settings-themes" id={id} role="radiogroup" aria-labelledby={`${id}-label`}>
      {DARK_THEMES.map((theme) => {
        const info = DARK_THEME_INFO[theme];
        const scheme = findScheme(info.scheme);
        const selected = theme === value;
        return (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx('settings-theme', selected && 'is-selected')}
            onClick={() => onChange(theme)}
            title={`${info.label}: ${info.description}`}
          >
            <span className="settings-theme__sample" aria-hidden="true" style={{ background: info.background }}>
              <span className="settings-theme__rail" style={{ background: info.chrome }}>
                <span className="settings-theme__tab is-active" style={{ background: info.surface }} />
                <span className="settings-theme__tab" />
                <span className="settings-theme__tab" />
              </span>
              <span className="settings-theme__main">
                <span className="settings-theme__strip" style={{ background: info.chrome }} />
                <span className="settings-theme__term" style={{ color: scheme?.foreground }}>
                  <span>
                    <span style={{ color: scheme?.green }}>❯</span> git log
                  </span>
                  <span>
                    <span style={{ color: scheme?.yellow }}>e277663</span> Fix
                  </span>
                  <span>
                    <span style={{ color: scheme?.blue }}>src</span> <span style={{ color: scheme?.red }}>M</span>
                  </span>
                </span>
              </span>
            </span>
            <span className="settings-theme__name">
              <span className="settings-theme__label">{info.label}</span>
              <span className="settings-theme__desc truncate">{info.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
