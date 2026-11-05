import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { rowMeta, type RowId, type SectionId } from './catalog';
import { controlIdFor, cx, groupHasMatches, useRowVisible, useSettingsFilter } from './filter';
import { useDebouncedCommit } from './use-debounced';

type ControlSlot = ReactNode | ((controlId: string) => ReactNode);

// ---- Layout -----------------------------------------------------------------------

interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  controlId?: string;
  children?: ControlSlot;
  /** Control goes under the label (textareas, grids). */
  stacked?: boolean;
  disabled?: boolean;
  /** Extra content under the description (warnings, hints). */
  note?: ReactNode;
}

/** One settings row: label and a one-line description on the left, the control on the right. */
export function Field({ label, description, controlId, children, stacked, disabled, note }: FieldProps) {
  const generated = `settings-f${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const id = controlId ?? generated;
  return (
    <div className={cx('settings-row', stacked && 'settings-row--stacked', disabled && 'is-disabled')}>
      <div className="settings-row__text">
        <label className="settings-row__label" id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        {description ? (
          <div className="settings-row__desc" id={`${id}-desc`}>
            {description}
          </div>
        ) : null}
        {note}
      </div>
      {children !== undefined ? <div className="settings-row__control">{typeof children === 'function' ? children(id) : children}</div> : null}
    </div>
  );
}

interface RowProps extends Omit<FieldProps, 'label' | 'controlId'> {
  id: RowId;
  label?: ReactNode;
}

/** A catalogued row: text comes from the catalog and the row hides when search excludes it. */
export function Row({ id, label, description, ...rest }: RowProps) {
  const visible = useRowVisible(id);
  if (!visible) return null;
  const meta = rowMeta(id);
  return <Field label={label ?? meta.label} description={description ?? meta.description} controlId={controlIdFor(id)} {...rest} />;
}

interface GroupProps {
  section: SectionId;
  title?: string;
  /** Shown next to the title (e.g. small buttons). */
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Render children without the bordered panel. */
  bare?: boolean;
}

export function Group({ section, title, actions, description, children, bare }: GroupProps) {
  const { matches } = useSettingsFilter();
  if (!groupHasMatches(matches, section, title)) return null;
  return (
    <section className="settings-group" aria-label={title}>
      {title || actions ? (
        <div className="settings-group__head">
          {title ? <h3 className="settings-group__title">{title}</h3> : <span />}
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </div>
      ) : null}
      {description ? <p className="settings-group__desc">{description}</p> : null}
      {bare ? children : <div className="settings-panel">{children}</div>}
    </section>
  );
}

export function Keys({ parts, empty = 'Not set' }: { parts: readonly string[]; empty?: string }) {
  if (!parts.length) return <span className="faint">{empty}</span>;
  return (
    <span className="settings-keys">
      {parts.map((part, index) => (
        <kbd key={`${index}-${part}`} className="kbd">
          {part}
        </kbd>
      ))}
    </span>
  );
}

// ---- Controls ---------------------------------------------------------------------

interface SwitchProps {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name when no <label htmlFor> points at the switch. */
  label?: string;
}

export function Switch({ id, checked, onChange, disabled, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('settings-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch__knob" aria-hidden="true" />
    </button>
  );
}

interface SegmentedProps<T extends string> {
  id?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  label?: string;
}

export function Segmented<T extends string>({ id, value, options, onChange, disabled, label }: SegmentedProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (activeIndex + delta + options.length) % options.length;
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      id={id}
      aria-labelledby={label ? undefined : id ? `${id}-label` : undefined}
      aria-label={label}
      className={cx('settings-segmented', disabled && 'is-disabled')}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={disabled}
          className={cx('settings-segmented__item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface SelectFieldProps<T extends string> {
  id?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  width?: number;
  label?: string;
}

export function SelectField<T extends string>({ id, value, options, onChange, disabled, width, label }: SelectFieldProps<T>) {
  return (
    <select
      id={id}
      aria-label={label}
      className="select settings-select"
      value={value}
      disabled={disabled}
      style={width ? { width } : undefined}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface TextFieldProps {
  id?: string;
  value: string;
  onCommit: (value: string) => unknown;
  placeholder?: string;
  mono?: boolean;
  /** Return an error message to block the save. */
  validate?: (value: string) => string | null;
  width?: number | string;
  multiline?: boolean;
  rows?: number;
  label?: string;
  disabled?: boolean;
  maxLength?: number;
}

/** Text input that saves ~300 ms after typing stops, on Enter and on blur. */
export function TextField({ id, value, onCommit, placeholder, mono, validate, width, multiline, rows = 4, label, disabled, maxLength }: TextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const generation = useRef(0);
  const { schedule, flush, cancel } = useDebouncedCommit<string>();
  const shown = draft ?? value;
  const error = draft !== null && validate ? validate(draft) : null;

  const change = (next: string) => {
    generation.current += 1;
    setDraft(next);
    if (validate?.(next)) cancel();
    else schedule(next, onCommit);
  };

  const finish = () => {
    if (error) {
      cancel();
      setDraft(null);
      return;
    }
    const current = generation.current;
    void flush().then(() => {
      if (generation.current === current) setDraft(null);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && draft !== null && draft !== value) {
      // Revert instead of closing settings.
      event.preventDefault();
      event.stopPropagation();
      cancel();
      setDraft(null);
    } else if (event.key === 'Enter' && !multiline) {
      void flush();
    }
  };

  const common = {
    id,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error && id ? `${id}-error` : undefined,
    value: shown,
    placeholder,
    disabled,
    maxLength,
    spellCheck: false,
    onChange: (event: { target: { value: string } }) => change(event.target.value),
    onBlur: finish,
    onKeyDown,
  };

  return (
    <span className={cx('settings-textfield', multiline && 'settings-textfield--multiline')} style={width ? { width } : undefined}>
      {multiline ? (
        <textarea {...common} rows={rows} className={cx('textarea', error && 'is-invalid')} />
      ) : (
        <input {...common} type="text" autoComplete="off" className={cx('input', mono && 'input--mono', error && 'is-invalid')} />
      )}
      {error ? (
        <span className="settings-field-error" id={id ? `${id}-error` : undefined} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

interface NumberFieldProps {
  id?: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  /** Empty input commits `undefined` (inherit) instead of being invalid. */
  optional?: boolean;
  onCommit: (value: number | undefined) => unknown;
  placeholder?: string;
  suffix?: string;
  width?: number;
  label?: string;
  disabled?: boolean;
}

function roundTo(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(value.toFixed(Math.min(4, decimals)));
}

/** Numeric input: saves only in-range values while typing; clamps on blur. Arrow keys step. */
export function NumberField({ id, value, min, max, step = 1, integer, optional, onCommit, placeholder, suffix, width = 72, label, disabled }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const generation = useRef(0);
  const { schedule, flush, cancel } = useDebouncedCommit<number | undefined>();
  const shown = draft ?? (value === undefined ? '' : String(value));

  const parse = (text: string): { ok: true; value: number | undefined } | { ok: false; number?: number } => {
    const trimmed = text.trim().replace(',', '.');
    if (!trimmed) return optional ? { ok: true, value: undefined } : { ok: false };
    const number = Number(trimmed);
    if (!Number.isFinite(number)) return { ok: false };
    if (number < min || number > max || (integer && !Number.isInteger(number))) return { ok: false, number };
    return { ok: true, value: number };
  };
  const parsed = draft === null ? null : parse(draft);
  const invalid = parsed !== null && !parsed.ok;

  const change = (text: string) => {
    generation.current += 1;
    setDraft(text);
    const result = parse(text);
    if (result.ok) schedule(result.value, onCommit);
    else cancel();
  };

  const finish = () => {
    const current = generation.current;
    if (parsed && !parsed.ok) {
      cancel();
      if (parsed.number !== undefined) {
        const clamped = Math.min(max, Math.max(min, integer ? Math.round(parsed.number) : parsed.number));
        schedule(clamped, onCommit);
        setDraft(String(clamped));
      } else {
        setDraft(null);
        return;
      }
    }
    void flush().then(() => {
      if (generation.current === current) setDraft(null);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const base = parsed?.ok && parsed.value !== undefined ? parsed.value : (value ?? min);
      const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
      change(String(roundTo(Math.min(max, Math.max(min, base + delta)), step)));
    } else if (event.key === 'Enter') {
      finish();
    } else if (event.key === 'Escape' && draft !== null && draft !== (value === undefined ? '' : String(value))) {
      // Revert instead of closing settings.
      event.preventDefault();
      event.stopPropagation();
      cancel();
      setDraft(null);
    }
  };

  return (
    <span className="settings-number">
      <input
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={cx('input input--mono settings-number__input', invalid && 'is-invalid')}
        style={{ width }}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        title={invalid ? `${min}–${max}` : undefined}
        onChange={(event) => change(event.target.value)}
        onBlur={finish}
        onKeyDown={onKeyDown}
      />
      {suffix ? <span className="settings-number__suffix faint">{suffix}</span> : null}
    </span>
  );
}
