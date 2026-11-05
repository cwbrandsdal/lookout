import { SETTINGS_LIMITS } from '../../shared/settings-defaults';
import type { LookoutSettings } from '../../shared/settings';
import { useApp } from '../../state/store';
import { acceleratorToChord } from './chords';
import { Group, NumberField, Row, Segmented, SelectField, Switch } from './controls';
import { AcceleratorField } from './recorder';
import { updateSettings } from './save';

function save(mutate: (draft: LookoutSettings) => void): void {
  void updateSettings(mutate);
}

export function GeneralSection() {
  const settings = useApp((state) => state.settings);
  const { window: win, notifications, quake } = settings;
  const sameHotkey = Boolean(win.summonHotkey && quake.enabled && acceleratorToChord(win.summonHotkey) === acceleratorToChord(quake.hotkey));

  return (
    <>
      <Group section="general">
        <Row id="general.defaultProfile">
          {(id) => (
            <SelectField
              id={id}
              width={220}
              value={settings.defaultProfile}
              options={settings.profiles.map((profile) => ({ value: profile.id, label: profile.hidden ? `${profile.name} (hidden)` : profile.name }))}
              onChange={(value) => save((draft) => { draft.defaultProfile = value; })}
            />
          )}
        </Row>
        <Row id="general.newTabDirectory">
          {(id) => (
            <SelectField
              id={id}
              width={220}
              value={win.newTabDirectory}
              options={[
                { value: 'inherit', label: 'Focused pane’s folder' },
                { value: 'profile', label: 'Profile’s starting folder' },
              ]}
              onChange={(value) => save((draft) => { draft.window.newTabDirectory = value; })}
            />
          )}
        </Row>
      </Group>

      <Group section="general" title="Session">
        <Row id="general.restoreSession">
          {(id) => <Switch id={id} checked={win.restoreSession} onChange={(value) => save((draft) => { draft.window.restoreSession = value; })} />}
        </Row>
        <Row id="general.restoreBuffers" disabled={!win.restoreSession}>
          {(id) => (
            <Switch
              id={id}
              checked={win.restoreBuffers && win.restoreSession}
              disabled={!win.restoreSession}
              onChange={(value) => save((draft) => { draft.window.restoreBuffers = value; })}
            />
          )}
        </Row>
        <Row id="general.confirmCloseRunning">
          {(id) => <Switch id={id} checked={win.confirmCloseRunning} onChange={(value) => save((draft) => { draft.window.confirmCloseRunning = value; })} />}
        </Row>
      </Group>

      <Group section="general" title="Window">
        <Row id="general.keepRunningInTray">
          {(id) => <Switch id={id} checked={win.keepRunningInTray} onChange={(value) => save((draft) => { draft.window.keepRunningInTray = value; })} />}
        </Row>
        <Row id="general.launchOnLogin">
          {(id) => <Switch id={id} checked={win.launchOnLogin} onChange={(value) => save((draft) => { draft.window.launchOnLogin = value; })} />}
        </Row>
        <Row id="general.paneHeaders">
          {(id) => (
            <Segmented
              id={id}
              value={win.paneHeaders}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' },
                { value: 'never', label: 'Never' },
              ]}
              onChange={(value) => save((draft) => { draft.window.paneHeaders = value; })}
            />
          )}
        </Row>
        <Row id="general.gitStatus">
          {(id) => <Switch id={id} checked={settings.gitStatus} onChange={(value) => save((draft) => { draft.gitStatus = value; })} />}
        </Row>
      </Group>

      <Group section="general" title="Notifications">
        <Row id="general.notificationsEnabled">
          {(id) => <Switch id={id} checked={notifications.enabled} onChange={(value) => save((draft) => { draft.notifications.enabled = value; })} />}
        </Row>
        <Row id="general.longCommandSeconds" disabled={!notifications.enabled}>
          {(id) => (
            <NumberField
              id={id}
              integer
              suffix="s"
              disabled={!notifications.enabled}
              value={notifications.longCommandSeconds}
              min={SETTINGS_LIMITS.longCommandSeconds.min}
              max={SETTINGS_LIMITS.longCommandSeconds.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.notifications.longCommandSeconds = value; })}
            />
          )}
        </Row>
        <Row id="general.onlyWhenUnfocused" disabled={!notifications.enabled}>
          {(id) => (
            <Switch
              id={id}
              checked={notifications.onlyWhenUnfocused}
              disabled={!notifications.enabled}
              onChange={(value) => save((draft) => { draft.notifications.onlyWhenUnfocused = value; })}
            />
          )}
        </Row>
      </Group>

      <Group section="general" title="Global hotkeys">
        <Row id="general.quakeEnabled">
          {(id) => <Switch id={id} checked={quake.enabled} onChange={(value) => save((draft) => { draft.quake.enabled = value; })} />}
        </Row>
        <Row id="general.quakeHotkey" disabled={!quake.enabled}>
          {(id) => (
            <AcceleratorField
              id={id}
              value={quake.hotkey}
              disabled={!quake.enabled}
              onChange={(value) => value && save((draft) => { draft.quake.hotkey = value; })}
            />
          )}
        </Row>
        <Row id="general.quakeHeight" disabled={!quake.enabled}>
          {(id) => (
            <NumberField
              id={id}
              integer
              suffix="%"
              disabled={!quake.enabled}
              value={quake.heightPercent}
              min={SETTINGS_LIMITS.quakeHeightPercent.min}
              max={SETTINGS_LIMITS.quakeHeightPercent.max}
              step={5}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.quake.heightPercent = value; })}
            />
          )}
        </Row>
        <Row
          id="general.summonHotkey"
          note={sameHotkey ? <div className="settings-note settings-note--warn">Same as the drop-down hotkey; only one of them can work.</div> : null}
        >
          {(id) => <AcceleratorField id={id} clearable value={win.summonHotkey} onChange={(value) => save((draft) => { draft.window.summonHotkey = value; })} />}
        </Row>
      </Group>
    </>
  );
}
