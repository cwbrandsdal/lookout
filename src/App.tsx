import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FolderKanban, RefreshCw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TabStrip } from './components/TabStrip';
import { SettingsView } from './components/SettingsView';
import { WorkspaceConfigurator } from './components/WorkspaceConfigurator';
import { WorkspaceView } from './components/WorkspaceView';
import { useAppStore } from './store/useAppStore';

function App() {
  return (
    <RendererErrorBoundary>
      <AppContent />
    </RendererErrorBoundary>
  );
}

function AppContent() {
  const restoredSessionsRef = useRef(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const initialize = useAppStore((state) => state.initialize);
  const handleTerminalEvent = useAppStore((state) => state.handleTerminalEvent);
  const restoreOpenSpaces = useAppStore((state) => state.restoreOpenSpaces);
  const clearWarning = useAppStore((state) => state.clearWarning);
  const setView = useAppStore((state) => state.setView);
  const openCreateConfigurator = useAppStore((state) => state.openCreateConfigurator);
  const activateSpace = useAppStore((state) => state.activateSpace);
  const closeSpace = useAppStore((state) => state.closeSpace);
  const renameSpace = useAppStore((state) => state.renameSpace);
  const openEditConfigurator = useAppStore((state) => state.openEditConfigurator);
  const { hydrated, warnings, view, activeSpaceId, settings, roles, presets, projectSpaces } = useAppStore(
    useShallow((state) => ({
      hydrated: state.hydrated,
      warnings: state.bootWarnings,
      view: state.view,
      activeSpaceId: state.activeSpaceId,
      settings: state.settings,
      roles: state.roles,
      presets: state.presets,
      projectSpaces: state.projectSpaces,
    })),
  );

  const bridgeAvailable = typeof window.lookout !== 'undefined';
  const bridgeError = bridgeAvailable
    ? null
    : 'Electron preload bridge is unavailable. The renderer cannot talk to the desktop backend.';
  const openSpaces = projectSpaces.filter((space) => space.isOpen);
  const activeSpace = openSpaces.find((space) => space.id === activeSpaceId) ?? openSpaces[0] ?? null;

  useEffect(() => {
    if (!bridgeAvailable) {
      return;
    }

    let mounted = true;

    void window.lookout
      .loadAppState()
      .then(({ state, warnings: bootWarnings }) => {
        if (mounted) {
          initialize(state, bootWarnings);
        }
      })
      .catch((error) => {
        if (mounted) {
          setBootError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribe = window.lookout.onTerminalEvent(handleTerminalEvent);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridgeAvailable, handleTerminalEvent, initialize]);

  useEffect(() => {
    if (!hydrated || restoredSessionsRef.current || !bridgeAvailable) {
      return;
    }

    restoredSessionsRef.current = true;
    void restoreOpenSpaces();
  }, [bridgeAvailable, hydrated, restoreOpenSpaces]);

  useEffect(() => {
    if (!hydrated || !bridgeAvailable) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void window.lookout.saveAppState({
        settings,
        roles,
        presets,
        projectSpaces,
      });
    }, 240);

    return () => window.clearTimeout(timeout);
  }, [bridgeAvailable, hydrated, presets, projectSpaces, roles, settings]);

  if (bridgeError) {
    return <DiagnosticScreen title="Desktop bridge missing" message={bridgeError} />;
  }

  if (bootError) {
    return <DiagnosticScreen title="Renderer boot failed" message={bootError} />;
  }

  if (!hydrated) {
    return <DiagnosticScreen title="Starting Lookout" message="Loading local state and preparing project spaces..." loading />;
  }

  return (
    <div className="app-shell">
      <div className="app-shell__backdrop" />
      <div className="app-shell__content">
        <TabStrip
          activeSpaceId={activeSpace?.id ?? null}
          onClose={(spaceId) => void closeSpace(spaceId)}
          onConfigure={openEditConfigurator}
          onCreate={() => openCreateConfigurator()}
          onOpenSettings={() => setView('settings')}
          onRename={renameSpace}
          onSelect={activateSpace}
          spaces={openSpaces}
        />

        {warnings.length ? (
          <div className="warning-stack">
            {warnings.map((warning) => (
              <div key={warning} className="warning-banner">
                <div className="warning-banner__copy">
                  <AlertTriangle size={16} />
                  <span>{warning}</span>
                </div>
                <button className="icon-button" onClick={() => clearWarning(warning)} type="button">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <main className="app-shell__main">
          {view === 'settings' ? (
            <SettingsView />
          ) : view === 'configurator' || !activeSpace ? (
            <WorkspaceConfigurator />
          ) : (
            <WorkspaceView space={activeSpace} />
          )}
        </main>
      </div>
    </div>
  );
}

function DiagnosticScreen({
  title,
  message,
  loading = false,
}: {
  title: string;
  message: string;
  loading?: boolean;
}) {
  return (
    <div className="diagnostic-shell">
      <div className="app-shell__backdrop" />
      <section className="diagnostic-card glass-card">
        <div className="diagnostic-card__icon">{loading ? <RefreshCw className="spin" size={26} /> : <FolderKanban size={26} />}</div>
        <div className="diagnostic-card__copy">
          <span className="eyebrow">Lookout</span>
          <h1>{title}</h1>
          <p>{message}</p>
        </div>
      </section>
    </div>
  );
}

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = {
    error: null as Error | null,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Lookout renderer crashed', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <DiagnosticScreen title="Renderer crashed" message={this.state.error.message} />;
    }

    return this.props.children;
  }
}

export default App;
