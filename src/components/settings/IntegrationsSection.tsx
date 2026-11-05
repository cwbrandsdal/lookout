import { Check, Copy, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { IntegrationId, IntegrationStatus } from '../../shared/ipc';
import { pushToast, useApp } from '../../state/store';
import { bridge } from './bridge';
import { Group, Row, Switch } from './controls';
import { useRowVisible } from './filter';

const CLI_EXAMPLES: ReadonlyArray<{ command: string; meaning: string }> = [
  { command: 'lookout .', meaning: 'New tab in the current folder' },
  { command: 'lookout -d C:\\src', meaning: 'New tab in C:\\src' },
  { command: 'lookout new-tab -p "Ubuntu" ; split-pane -V -p pwsh', meaning: 'Ubuntu tab with a PowerShell split' },
  { command: 'lookout -w new', meaning: 'Open a new window' },
];

type Statuses = Partial<Record<IntegrationId, IntegrationStatus>>;

function IntegrationRow({
  id,
  status,
  busy,
  error,
  onToggle,
  children,
}: {
  id: IntegrationId;
  status: IntegrationStatus | undefined;
  busy: boolean;
  error: string | undefined;
  onToggle: (id: IntegrationId, enabled: boolean) => void;
  children?: ReactNode;
}) {
  const available = status?.available ?? false;
  return (
    <Row
      id={`integrations.${id}`}
      disabled={!status || !available}
      note={
        <>
          {children}
          {status?.detail && !error ? <div className="settings-note">{status.detail}</div> : null}
          {error ? (
            <div className="settings-note settings-note--error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      }
    >
      {(controlId) => (
        <span className="settings-inline">
          {!status ? <span className="faint">Checking…</span> : busy ? <span className="faint">Applying…</span> : null}
          <Switch id={controlId} checked={Boolean(status?.enabled)} disabled={!status || !available || busy} onChange={(enabled) => onToggle(id, enabled)} />
        </span>
      )}
    </Row>
  );
}

function CopyLine({ command, meaning }: { command: string; meaning: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="settings-cli__line">
      <code className="settings-cli__command">{command}</code>
      <span className="settings-cli__meaning faint">{meaning}</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm settings-cli__copy"
        aria-label={`Copy ${command}`}
        title="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </li>
  );
}

export function IntegrationsSection() {
  const elevated = useApp((state) => state.elevated);
  const [statuses, setStatuses] = useState<Statuses | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<IntegrationId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<IntegrationId, string>>>({});
  const showCli = useRowVisible('integrations.cliOnPath');

  const refresh = useCallback(async () => {
    try {
      const list = await bridge().getIntegrations();
      setStatuses(Object.fromEntries(list.map((status) => [status.id, status])) as Statuses);
      setLoadError(null);
    } catch (error) {
      setStatuses({});
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (id: IntegrationId, enabled: boolean) => {
    setBusy(id);
    setErrors((current) => ({ ...current, [id]: undefined }));
    try {
      const result = await bridge().setIntegration(id, enabled);
      if (result.enabled !== enabled) {
        const message = result.detail ?? 'The change did not take effect.';
        setErrors((current) => ({ ...current, [id]: message }));
        pushToast({ tone: 'error', title: 'Integration not changed', body: message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrors((current) => ({ ...current, [id]: message }));
      pushToast({ tone: 'error', title: 'Integration not changed', body: message });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const rowProps = (id: IntegrationId) => ({
    id,
    status: statuses?.[id] ?? (statuses ? { id, enabled: false, available: false, detail: 'Status unavailable.' } : undefined),
    busy: busy === id,
    error: errors[id],
    onToggle: (target: IntegrationId, enabled: boolean) => void toggle(target, enabled),
  });

  return (
    <>
      {loadError ? (
        <div className="settings-banner settings-banner--error" role="alert">
          Could not read integration status: {loadError}
        </div>
      ) : null}

      <Group section="integrations">
        <IntegrationRow {...rowProps('defaultTerminal')}>
          <div className="settings-note">
            Programs started from Explorer, Run or another app open in a Lookout tab instead of the classic console. Administrator consoles still open in the
            classic console.
          </div>
          <div className="settings-note">
            To go back, turn this off: the previous console setting is restored. If Lookout is already gone, choose Windows Console Host under Settings →
            System → For developers → Terminal.
          </div>
        </IntegrationRow>
        <IntegrationRow {...rowProps('explorerMenu')}>
          <div className="settings-note">On Windows 11 the entry is under “Show more options” (Shift+F10).</div>
        </IntegrationRow>
        <IntegrationRow {...rowProps('cliOnPath')} />
        {showCli ? (
          <div className="settings-panel__block">
            <ul className="settings-cli" aria-label="lookout command examples">
              {CLI_EXAMPLES.map((example) => (
                <CopyLine key={example.command} {...example} />
              ))}
            </ul>
            <div className="settings-note">Open a new terminal after enabling it so PATH is reloaded. The syntax follows wt.exe.</div>
          </div>
        ) : null}
      </Group>

      <Group section="integrations" title="Administrator">
        <Row id="integrations.admin" description={elevated ? 'This window is already running as administrator.' : undefined}>
          <button type="button" className="btn btn--sm" disabled={elevated} onClick={() => bridge().openAdminWindow()}>
            <ShieldCheck size={13} />
            Open administrator window
          </button>
        </Row>
      </Group>
    </>
  );
}
