import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MonitorCog } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../store/useAppStore';
import type { AppUpdateState } from '../types/electron-api';

const DEFAULT_UPDATE_STATE: AppUpdateState = {
  phase: 'unsupported',
  currentVersion: '0.0.0',
};

export function SettingsView() {
  const { settings, updateSettings, setView, activeSpaceId } = useAppStore(
    useShallow((state) => ({
      settings: state.settings,
      updateSettings: state.updateSettings,
      setView: state.setView,
      activeSpaceId: state.activeSpaceId,
    })),
  );
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [fontStatus, setFontStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [updateState, setUpdateState] = useState<AppUpdateState>(DEFAULT_UPDATE_STATE);

  useEffect(() => {
    let isMounted = true;

    void window.lookout
      .listLocalFonts()
      .catch(async () => {
        if (typeof window.queryLocalFonts !== 'function') {
          throw new Error('No local font enumeration available.');
        }

        const fonts = await window.queryLocalFonts();
        return [...new Set(fonts.map((font) => font.family))].sort((left, right) => left.localeCompare(right));
      })
      .then((fonts) => {
        if (!isMounted) {
          return;
        }

        setAvailableFonts(fonts);
        setFontStatus('ready');
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        setAvailableFonts([]);
        setFontStatus('error');
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    void window.lookout.getAppUpdateState().then((state) => {
      if (isMounted) {
        setUpdateState(state);
      }
    });

    const unsubscribe = window.lookout.onAppUpdateState((state) => {
      if (isMounted) {
        setUpdateState(state);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const fontOptions = useMemo(() => {
    if (!settings.terminalFontFace.trim()) {
      return availableFonts;
    }

    return availableFonts.includes(settings.terminalFontFace)
      ? availableFonts
      : [settings.terminalFontFace, ...availableFonts];
  }, [availableFonts, settings.terminalFontFace]);

  return (
    <section className="settings-view">
      <div className="settings-panel glass-card">
        <div className="settings-panel__header">
          <div>
            <span className="eyebrow">Settings</span>
            <h1>App settings</h1>
            <p>Manage updates and terminal appearance.</p>
          </div>
          <button
            className="button button--ghost button--compact"
            onClick={() => setView(activeSpaceId ? 'workspace' : 'configurator')}
            type="button"
          >
            <ArrowLeft size={14} />
            Back
          </button>
        </div>

        <section className="settings-update">
          <div className="settings-update__copy">
            <span className="eyebrow">Updates</span>
            <strong>
              Lookout {updateState.currentVersion}
              {updateState.availableVersion ? ` -> ${updateState.availableVersion}` : ''}
            </strong>
            <p>{describeUpdateState(updateState)}</p>
          </div>

          <div className="settings-update__actions">
            <button
              className="button button--secondary button--compact"
              disabled={updateState.phase === 'checking' || updateState.phase === 'downloading'}
              onClick={() => void window.lookout.checkForAppUpdates()}
              type="button"
            >
              Check for updates
            </button>
            {updateState.phase === 'available' ? (
              <button className="button button--primary button--compact" onClick={() => void window.lookout.downloadAppUpdate()} type="button">
                Download update
              </button>
            ) : null}
            {updateState.phase === 'downloaded' ? (
              <button className="button button--primary button--compact" onClick={() => void window.lookout.installAppUpdate()} type="button">
                Restart to install
              </button>
            ) : null}
          </div>
        </section>

        {updateState.phase === 'downloading' ? (
          <div className="settings-update__progress">
            <div className="settings-update__progress-bar">
              <span style={{ width: `${Math.max(0, Math.min(100, updateState.percent ?? 0))}%` }} />
            </div>
            <p>
              Downloading {formatPercent(updateState.percent)}{updateState.bytesPerSecond ? ` at ${formatBytes(updateState.bytesPerSecond)}/s` : ''}
            </p>
          </div>
        ) : null}

        {updateState.releaseNotes ? (
          <div className="settings-update__notes glass-card">
            <span className="eyebrow">Release Notes</span>
            <pre>{updateState.releaseNotes}</pre>
          </div>
        ) : null}

        <div className="settings-grid">
          <label className="field">
            <span className="field__label">Installed terminal font</span>
            <select
              className="field__input"
              disabled={fontStatus === 'loading' || !fontOptions.length}
              onChange={(event) => updateSettings({ terminalFontFace: event.target.value })}
              value={settings.terminalFontFace}
            >
              {!fontOptions.length ? (
                <option value={settings.terminalFontFace}>{fontStatus === 'loading' ? 'Loading fonts...' : 'No fonts found'}</option>
              ) : null}
              {fontOptions.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Manual font face override</span>
            <input
              className="field__input"
              onChange={(event) => updateSettings({ terminalFontFace: event.target.value })}
              placeholder="MesloLGL Nerd Font Propo"
              value={settings.terminalFontFace}
            />
          </label>

          <label className="field">
            <span className="field__label">Terminal font size</span>
            <input
              className="field__input"
              max={24}
              min={8}
              onChange={(event) => updateSettings({ terminalFontSize: Number(event.target.value) || 13 })}
              type="number"
              value={settings.terminalFontSize}
            />
          </label>

          <label className="field">
            <span className="field__label">Line height</span>
            <input
              className="field__input"
              max={1.4}
              min={0.8}
              onChange={(event) =>
                updateSettings({
                  terminalLineHeight: Number.parseFloat(event.target.value) || 1,
                })
              }
              step={0.01}
              type="number"
              value={settings.terminalLineHeight}
            />
          </label>

          <label className="field">
            <span className="field__label">Letter spacing</span>
            <input
              className="field__input"
              max={2}
              min={-1}
              onChange={(event) =>
                updateSettings({
                  terminalLetterSpacing: Number.parseFloat(event.target.value) || 0,
                })
              }
              step={0.1}
              type="number"
              value={settings.terminalLetterSpacing}
            />
          </label>
        </div>

        <label className="toggle">
          <input
            checked={settings.showPinnedTabsOnly}
            onChange={(event) => updateSettings({ showPinnedTabsOnly: event.target.checked })}
            type="checkbox"
          />
          <span>Show only pinned spaces in the top tab bar, with the rest under More.</span>
        </label>

        <p className="muted-copy">
          {fontStatus === 'loading'
            ? 'Loading installed fonts from Windows...'
            : fontStatus === 'error'
              ? 'Installed fonts could not be read. You can still type the font face manually.'
              : `${availableFonts.length} installed font faces available in the dropdown.`}
        </p>

        <div className="settings-preview">
          <div className="settings-preview__icon">
            <MonitorCog size={18} />
          </div>
          <div>
            <strong>{settings.terminalFontFace}</strong>
            <p>Applied to new and existing terminal panes in the current session.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function describeUpdateState(updateState: AppUpdateState): string {
  switch (updateState.phase) {
    case 'idle':
      return 'Ready to check GitHub Releases for new versions.';
    case 'unsupported':
      return updateState.error ?? 'Updates are available only in packaged builds.';
    case 'checking':
      return 'Checking GitHub Releases for a newer version.';
    case 'available':
      return `Version ${updateState.availableVersion ?? 'unknown'} is available.`;
    case 'not-available':
      return 'You are already on the latest published version.';
    case 'downloading':
      return `Downloading ${updateState.availableVersion ?? 'the latest update'}.`;
    case 'downloaded':
      return 'Update downloaded. Restart the app to install it.';
    case 'error':
      return updateState.error ?? 'Update check failed.';
    default:
      return 'Update state unavailable.';
  }
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0%';
  }

  return `${value.toFixed(1)}%`;
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let current = value;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current.toFixed(current >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
