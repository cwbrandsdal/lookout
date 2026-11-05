import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { acceleratorParts, captureAccelerator, type CaptureResult } from './chords';
import { Keys } from './controls';
import { RECORDING_ATTRIBUTE } from './filter';

let activeRecorders = 0;

interface KeyRecorderProps {
  capture: (event: KeyboardEvent) => CaptureResult;
  onCapture: (value: string) => void;
  onCancel: () => void;
  prompt?: string;
}

/**
 * Listens for the next shortcut (window capture phase, so terminals and global
 * shortcuts don't see it). Esc or leaving the field cancels.
 */
export function KeyRecorder({ capture, onCapture, onCancel, prompt = 'Press a shortcut' }: KeyRecorderProps) {
  const target = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = `settings-rec${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const handlers = useRef({ capture, onCapture, onCancel });

  useEffect(() => {
    handlers.current = { capture, onCapture, onCancel };
  });

  useEffect(() => {
    const root = document.documentElement;
    activeRecorders += 1;
    root.setAttribute(RECORDING_ATTRIBUTE, '');
    target.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === 'Process') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = handlers.current.capture(event);
      if (result.kind === 'cancel') handlers.current.onCancel();
      else if (result.kind === 'error') setError(result.message);
      else if (result.kind === 'value') handlers.current.onCapture(result.value);
    };
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      activeRecorders -= 1;
      if (!activeRecorders) root.removeAttribute(RECORDING_ATTRIBUTE);
    };
  }, []);

  return (
    <span className="settings-recorder">
      <button ref={target} type="button" className="settings-recorder__target" onBlur={onCancel} aria-describedby={error ? errorId : undefined}>
        <span className="settings-recorder__dot" aria-hidden="true" />
        {prompt}
        <span className="faint">· Esc cancels</span>
      </button>
      {error ? (
        <span className="settings-recorder__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

interface AcceleratorFieldProps {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  clearable?: boolean;
  disabled?: boolean;
}

/** A global hotkey (Electron accelerator) with record and optional clear. */
export function AcceleratorField({ id, value, onChange, clearable, disabled }: AcceleratorFieldProps) {
  const [recording, setRecording] = useState(false);

  if (recording) {
    return (
      <KeyRecorder
        capture={captureAccelerator}
        prompt="Press a hotkey"
        onCancel={() => setRecording(false)}
        onCapture={(accelerator) => {
          setRecording(false);
          onChange(accelerator);
        }}
      />
    );
  }

  const parts = value ? acceleratorParts(value) : [];
  return (
    <span className="settings-hotkey">
      <button
        id={id}
        type="button"
        className="settings-hotkey__value"
        disabled={disabled}
        title="Click to record a new hotkey"
        onClick={() => setRecording(true)}
      >
        <Keys parts={parts} />
        <span className="settings-hotkey__hint">{value ? 'Change' : 'Record'}</span>
      </button>
      {clearable && value ? (
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Clear hotkey" title="Clear" disabled={disabled} onClick={() => onChange(null)}>
          <X size={13} />
        </button>
      ) : null}
    </span>
  );
}
