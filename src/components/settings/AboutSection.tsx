import { Download, ExternalLink, FolderOpen, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { AppUpdateState } from '../../shared/ipc';
import { useApp } from '../../state/store';
import { bridge } from './bridge';
import { Group, Row } from './controls';
import { cx } from './filter';

const RELEASES_URL = 'https://github.com/cwbrandsdal/lookout/releases';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function UpdateControls({ state }: { state: AppUpdateState }) {
  const checked = formatTime(state.checkedAt);
  const check = (label = 'Check for updates') => (
    <button type="button" className="btn btn--sm" onClick={() => bridge().checkForUpdates()}>
      <RefreshCw size={13} />
      {label}
    </button>
  );

  switch (state.phase) {
    case 'unsupported':
      return <span className="faint">{state.error ?? 'Updates are available in the installed app.'}</span>;
    case 'checking':
      return (
        <span className="settings-inline faint">
          <RefreshCw size={13} className="settings-spin" />
          Checking…
        </span>
      );
    case 'available':
      return (
        <span className="settings-inline">
          <span>
            Version <span className="mono">{state.availableVersion}</span> is available
          </span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => bridge().downloadUpdate()}>
            <Download size={13} />
            Download
          </button>
        </span>
      );
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, state.percent ?? 0));
      return (
        <span className="settings-update-progress">
          <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Download progress">
            <span className="settings-progress__bar" style={{ width: `${percent}%` }} />
          </span>
          <span className="faint mono">
            {Math.round(percent)}%{state.bytesPerSecond ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ''}
          </span>
        </span>
      );
    }
    case 'downloaded':
      return (
        <span className="settings-inline">
          {state.error ? (
            <span className="settings-error-text truncate" title={state.error}>
              {state.error}
            </span>
          ) : (
            <span>
              Version <span className="mono">{state.availableVersion}</span> is ready
            </span>
          )}
          <button type="button" className="btn btn--primary btn--sm" onClick={() => bridge().installUpdate()}>
            <RotateCcw size={13} />
            Restart to install
          </button>
        </span>
      );
    case 'error':
      return (
        <span className="settings-inline">
          <span className="settings-error-text truncate" title={state.error}>
            {state.error ?? 'Update check failed.'}
          </span>
          {check('Try again')}
        </span>
      );
    case 'not-available':
      return (
        <span className="settings-inline">
          <span className="muted">Up to date{checked ? ` · checked ${checked}` : ''}</span>
          {check('Check again')}
        </span>
      );
    default:
      return check();
  }
}

export function AboutSection() {
  const { appVersion, update, settingsPath, elevated } = useApp(
    useShallow((state) => ({ appVersion: state.appVersion, update: state.update, settingsPath: state.settingsPath, elevated: state.elevated })),
  );
  const [fetched, setFetched] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let live = true;
    bridge()
      .getUpdateState()
      .then((state) => {
        if (live) setFetched(state);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The store follows onUpdateState events; before the first one, use the fetched snapshot.
  const state = update.currentVersion ? update : (fetched ?? update);
  const version = appVersion || state.currentVersion;

  return (
    <Group section="about">
      <Row id="about.version">
        <span className="settings-inline">
          <span className="mono">Lookout {version || '—'}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => bridge().openExternal(RELEASES_URL)}>
            <ExternalLink size={13} />
            Release notes
          </button>
        </span>
      </Row>
      <Row
        id="about.updates"
        description={state.phase === 'downloaded' || state.phase === 'available' ? state.releaseName : undefined}
      >
        <UpdateControls state={state} />
      </Row>
      <Row id="about.settingsFile">
        <span className="settings-inline settings-path">
          <code className="settings-path__value truncate" title={settingsPath}>
            {settingsPath || 'settings.json'}
          </code>
          <button type="button" className="btn btn--sm" onClick={() => bridge().openSettingsFile()}>
            <FolderOpen size={13} />
            Open
          </button>
        </span>
      </Row>
      <Row id="about.elevation" description={elevated ? 'Shells in this window run with full rights.' : 'Admin shells open in a separate elevated window.'}>
        <span className="settings-inline">
          <span className={cx('chip', elevated && 'settings-chip--admin')}>
            {elevated ? <ShieldCheck size={11} /> : null}
            {elevated ? 'Administrator' : 'Standard user'}
          </span>
          {!elevated ? (
            <button type="button" className="btn btn--sm" onClick={() => bridge().openAdminWindow()}>
              Open administrator window
            </button>
          ) : null}
        </span>
      </Row>
    </Group>
  );
}
