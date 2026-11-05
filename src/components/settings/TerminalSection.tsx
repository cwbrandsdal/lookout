import { DEFAULT_WORD_SEPARATORS, SETTINGS_LIMITS } from '../../shared/settings-defaults';
import type { LookoutSettings } from '../../shared/settings';
import { useApp } from '../../state/store';
import { Group, NumberField, Row, SelectField, Switch, TextField } from './controls';
import { updateSettings } from './save';

function save(mutate: (draft: LookoutSettings) => void): void {
  void updateSettings(mutate);
}

export function TerminalSection() {
  const terminal = useApp((state) => state.settings.terminal);

  return (
    <>
      <Group section="terminal">
        <Row id="terminal.scrollback">
          {(id) => (
            <NumberField
              id={id}
              integer
              width={96}
              suffix="lines"
              step={1000}
              value={terminal.scrollback}
              min={SETTINGS_LIMITS.scrollback.min}
              max={SETTINGS_LIMITS.scrollback.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.terminal.scrollback = value; })}
            />
          )}
        </Row>
      </Group>

      <Group section="terminal" title="Clipboard">
        <Row id="terminal.copyOnSelect">
          {(id) => <Switch id={id} checked={terminal.copyOnSelect} onChange={(value) => save((draft) => { draft.terminal.copyOnSelect = value; })} />}
        </Row>
        <Row id="terminal.copyFormatting">
          {(id) => <Switch id={id} checked={terminal.copyFormatting} onChange={(value) => save((draft) => { draft.terminal.copyFormatting = value; })} />}
        </Row>
        <Row id="terminal.trimTrailingWhitespace">
          {(id) => (
            <Switch id={id} checked={terminal.trimTrailingWhitespace} onChange={(value) => save((draft) => { draft.terminal.trimTrailingWhitespace = value; })} />
          )}
        </Row>
        <Row id="terminal.rightClick">
          {(id) => (
            <SelectField
              id={id}
              width={200}
              value={terminal.rightClick}
              options={[
                { value: 'copyPaste', label: 'Copy selection or paste' },
                { value: 'menu', label: 'Open the context menu' },
              ]}
              onChange={(value) => save((draft) => { draft.terminal.rightClick = value; })}
            />
          )}
        </Row>
        <Row id="terminal.middleClickPaste">
          {(id) => <Switch id={id} checked={terminal.middleClickPaste} onChange={(value) => save((draft) => { draft.terminal.middleClickPaste = value; })} />}
        </Row>
        <Row id="terminal.warnMultilinePaste">
          {(id) => <Switch id={id} checked={terminal.warnMultilinePaste} onChange={(value) => save((draft) => { draft.terminal.warnMultilinePaste = value; })} />}
        </Row>
        <Row id="terminal.warnLargePasteBytes">
          {(id) => (
            <NumberField
              id={id}
              integer
              width={96}
              suffix="bytes"
              step={1024}
              value={terminal.warnLargePasteBytes}
              min={SETTINGS_LIMITS.warnLargePasteBytes.min}
              max={SETTINGS_LIMITS.warnLargePasteBytes.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.terminal.warnLargePasteBytes = value; })}
            />
          )}
        </Row>
      </Group>

      <Group section="terminal" title="Selection and links">
        <Row id="terminal.wordSeparators">
          {(id) => (
            <span className="settings-inline">
              <TextField
                id={id}
                mono
                width={200}
                value={terminal.wordSeparators}
                onCommit={(value) => updateSettings((draft) => { draft.terminal.wordSeparators = value; })}
              />
              {terminal.wordSeparators !== DEFAULT_WORD_SEPARATORS ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => save((draft) => { draft.terminal.wordSeparators = DEFAULT_WORD_SEPARATORS; })}
                >
                  Reset
                </button>
              ) : null}
            </span>
          )}
        </Row>
        <Row id="terminal.linkRequiresCtrl">
          {(id) => <Switch id={id} checked={terminal.linkRequiresCtrl} onChange={(value) => save((draft) => { draft.terminal.linkRequiresCtrl = value; })} />}
        </Row>
      </Group>

      <Group section="terminal" title="Bell">
        <Row id="terminal.bellSound">
          {(id) => <Switch id={id} checked={terminal.bell.sound} onChange={(value) => save((draft) => { draft.terminal.bell.sound = value; })} />}
        </Row>
        <Row id="terminal.bellVisual">
          {(id) => <Switch id={id} checked={terminal.bell.visual} onChange={(value) => save((draft) => { draft.terminal.bell.visual = value; })} />}
        </Row>
        <Row id="terminal.bellTaskbar">
          {(id) => <Switch id={id} checked={terminal.bell.taskbar} onChange={(value) => save((draft) => { draft.terminal.bell.taskbar = value; })} />}
        </Row>
      </Group>

      <Group section="terminal" title="Behavior">
        <Row id="terminal.closeOnExit">
          {(id) => (
            <SelectField
              id={id}
              width={200}
              value={terminal.closeOnExit}
              options={[
                { value: 'graceful', label: 'Close if it succeeded' },
                { value: 'always', label: 'Always close' },
                { value: 'never', label: 'Keep the pane open' },
              ]}
              onChange={(value) => save((draft) => { draft.terminal.closeOnExit = value; })}
            />
          )}
        </Row>
        <Row id="terminal.smoothScroll">
          {(id) => <Switch id={id} checked={terminal.smoothScroll} onChange={(value) => save((draft) => { draft.terminal.smoothScroll = value; })} />}
        </Row>
      </Group>
    </>
  );
}
