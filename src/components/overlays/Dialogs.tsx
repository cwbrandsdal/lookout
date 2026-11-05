import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { focusPane, pendingPasteResolvers } from '../../state/actions';
import { getState, patchUi, type DialogState } from '../../state/store';
import { cx } from './cx';
import { restoreTerminalFocus } from './focus';
import { describePaste, joinLines, splitLines, visualizeControls } from './paste-format';

type ConfirmState = Extract<DialogState, { kind: 'confirm' }>;
type PasteState = Extract<DialogState, { kind: 'paste' }>;
type PromptState = Extract<DialogState, { kind: 'prompt' }>;

const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 400;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Runs the callback, then clears the dialog unless the callback replaced it with a new one. */
function finishDialog(dialog: DialogState, callback?: () => void): void {
  try {
    callback?.();
  } finally {
    if (getState().ui.dialog === dialog) {
      patchUi({ dialog: null });
    }
  }
}

export function DialogHost({ dialog }: { dialog: DialogState }) {
  useEffect(() => () => restoreTerminalFocus(), []);

  switch (dialog.kind) {
    case 'confirm':
      return <ConfirmDialog dialog={dialog} />;
    case 'paste':
      return <PasteDialog dialog={dialog} />;
    case 'prompt':
      return <PromptDialog dialog={dialog} />;
  }
}

interface ModalProps {
  label: string;
  wide?: boolean;
  onCancel: () => void;
  /** Enter pressed while focus is not on a control (buttons and inputs handle Enter natively). */
  onEnter?: () => void;
  children: ReactNode;
}

function Modal({ label, wide, onCancel, onEnter, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Enter') {
      const target = event.target;
      const native = target instanceof HTMLButtonElement || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (!native && onEnter && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onEnter();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    // Focus trap.
    const panel = panelRef.current;
    const focusables = panel ? [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    if (!panel || !focusables.length) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    const outside = !panel.contains(current);
    if (event.shiftKey && (current === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const onScrimMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="ov-scrim ov-scrim--dialog" onMouseDown={onScrimMouseDown}>
      {/* tabIndex -1: clicks on plain text keep focus inside, so Esc/Enter/Tab still reach the dialog. */}
      <div
        ref={panelRef}
        className={cx('ov-dialog', wide && 'ov-dialog--wide')}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ dialog }: { dialog: ConfirmState }) {
  const cancel = () => finishDialog(dialog, dialog.onCancel);
  const confirm = () => finishDialog(dialog, dialog.onConfirm);
  return (
    <Modal label={dialog.title} onCancel={cancel} onEnter={confirm}>
      <h2 className="ov-dialog__title">{dialog.title}</h2>
      <p className="ov-dialog__message">{dialog.message}</p>
      {dialog.detail?.length ? (
        <ul className="ov-dialog__detail mono">
          {dialog.detail.map((line, index) => (
            <li key={index} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ov-dialog__actions">
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className={cx('btn', dialog.danger ? 'btn--danger' : 'btn--primary')} autoFocus onClick={confirm}>
          {dialog.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function PasteDialog({ dialog }: { dialog: PasteState }) {
  const info = useMemo(() => describePaste(dialog.text, dialog.reason), [dialog.text, dialog.reason]);
  const lines = useMemo(() => splitLines(dialog.text), [dialog.text]);
  const preview = useMemo(
    () =>
      lines.slice(0, PREVIEW_LINES).map((line) => ({
        segments: visualizeControls(line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) : line),
        clipped: line.length > PREVIEW_CHARS,
      })),
    [lines],
  );

  const finish = (value: string | null) => {
    const { paneId } = dialog;
    try {
      if (value === null) {
        pendingPasteResolvers.get(paneId)?.(null);
      } else {
        dialog.onConfirm(value);
      }
    } finally {
      pendingPasteResolvers.delete(paneId);
      if (getState().ui.dialog === dialog) {
        patchUi({ dialog: null });
      }
      focusPane(paneId);
    }
  };
  const hidden = lines.length - preview.length;

  return (
    <Modal label={info.title} wide onCancel={() => finish(null)} onEnter={() => finish(dialog.text)}>
      <h2 className="ov-dialog__title">{info.title}</h2>
      <p className="ov-dialog__message">{info.message}</p>
      <div className="ov-paste" role="region" aria-label="Paste preview" tabIndex={0}>
        {preview.map((line, index) => (
          <div key={index} className="ov-paste__line">
            <span className="ov-paste__ln">{index + 1}</span>
            <span className="ov-paste__text">
              {line.segments.map((segment, part) =>
                segment.kind ? (
                  <span key={part} className={cx('ov-ctl', segment.kind === 'tab' && 'ov-ctl--tab')}>
                    {segment.text}
                  </span>
                ) : (
                  <span key={part}>{segment.text}</span>
                ),
              )}
              {line.clipped && <span className="ov-ctl ov-ctl--tab">…</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="ov-dialog__meta mono">
        {info.lines} line{info.lines === 1 ? '' : 's'} · {info.size}
        {hidden > 0 ? ` · ${hidden} more not shown` : ''}
      </div>
      <div className="ov-dialog__actions">
        <button type="button" className="btn" onClick={() => finish(null)}>
          Cancel
        </button>
        {lines.length > 1 && (
          <button type="button" className="btn" onClick={() => finish(joinLines(dialog.text))}>
            Paste as one line
          </button>
        )}
        <button type="button" className="btn btn--primary" autoFocus onClick={() => finish(dialog.text)}>
          Paste
        </button>
      </div>
    </Modal>
  );
}

function PromptDialog({ dialog }: { dialog: PromptState }) {
  const [value, setValue] = useState(dialog.initial);
  const cancel = () => finishDialog(dialog);
  const accept = () => finishDialog(dialog, () => dialog.onSubmit(value));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    accept();
  };
  return (
    <Modal label={dialog.title} onCancel={cancel} onEnter={accept}>
      <form className="ov-dialog__form" onSubmit={submit}>
        <h2 className="ov-dialog__title">{dialog.title}</h2>
        <label className="ov-field">
          <span className="ov-field__label">{dialog.label}</span>
          <input
            className="input"
            autoFocus
            value={value}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <div className="ov-dialog__actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary">
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
