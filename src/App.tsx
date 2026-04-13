import { Component, type ErrorInfo, type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, FolderKanban, RefreshCw, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TabStrip } from './components/TabStrip';
import { SettingsView } from './components/SettingsView';
import { WorkspaceConfigurator } from './components/WorkspaceConfigurator';
import { WorkspaceView } from './components/WorkspaceView';
import { useAppStore } from './store/useAppStore';
import type { AppUpdateState } from './types/electron-api';
import type { ProjectSpace } from './types/app';

const DEFAULT_UPDATE_STATE: AppUpdateState = {
  phase: 'unsupported',
  currentVersion: '0.0.0',
};

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
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(DEFAULT_UPDATE_STATE);
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(null);
  const [spaceSwitcherOpen, setSpaceSwitcherOpen] = useState(false);
  const initialize = useAppStore((state) => state.initialize);
  const handleTerminalEvent = useAppStore((state) => state.handleTerminalEvent);
  const restoreOpenSpaces = useAppStore((state) => state.restoreOpenSpaces);
  const clearWarning = useAppStore((state) => state.clearWarning);
  const setView = useAppStore((state) => state.setView);
  const openCreateConfigurator = useAppStore((state) => state.openCreateConfigurator);
  const activateSpace = useAppStore((state) => state.activateSpace);
  const reopenSpace = useAppStore((state) => state.reopenSpace);
  const closeSpace = useAppStore((state) => state.closeSpace);
  const renameSpace = useAppStore((state) => state.renameSpace);
  const openEditConfigurator = useAppStore((state) => state.openEditConfigurator);
  const toggleSpacePinned = useAppStore((state) => state.toggleSpacePinned);
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
  const updateNoticeKey = useMemo(() => {
    if (appUpdateState.phase === 'available' || appUpdateState.phase === 'downloaded') {
      return `${appUpdateState.phase}:${appUpdateState.availableVersion ?? 'unknown'}`;
    }

    return null;
  }, [appUpdateState.availableVersion, appUpdateState.phase]);
  const showUpdateBanner = updateNoticeKey !== null && updateNoticeKey !== dismissedUpdateKey;

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

  useEffect(() => {
    if (!bridgeAvailable) {
      return;
    }

    let isMounted = true;

    void window.lookout.getAppUpdateState().then((state) => {
      if (isMounted) {
        setAppUpdateState(state);
      }
    });

    const unsubscribe = window.lookout.onAppUpdateState((state) => {
      if (isMounted) {
        setAppUpdateState(state);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [bridgeAvailable]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSpaceSwitcherOpen(true);
      }

      if (event.key === 'Escape') {
        setSpaceSwitcherOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
          onOpenSwitcher={() => setSpaceSwitcherOpen(true)}
          onOpenSettings={() => setView('settings')}
          onRename={renameSpace}
          onSelect={activateSpace}
          onTogglePinned={toggleSpacePinned}
          showPinnedTabsOnly={settings.showPinnedTabsOnly}
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

        {showUpdateBanner ? (
          <div className="update-banner">
            <div className="update-banner__copy">
              <Download size={16} />
              <div>
                <strong>
                  {appUpdateState.phase === 'downloaded'
                    ? `Update ${appUpdateState.availableVersion ?? ''} is ready`
                    : `Update ${appUpdateState.availableVersion ?? ''} is available`}
                </strong>
                <span>
                  {appUpdateState.phase === 'downloaded'
                    ? 'Restart Lookout to install the downloaded update.'
                    : 'A newer version was found automatically when the app opened.'}
                </span>
              </div>
            </div>
            <div className="update-banner__actions">
              {appUpdateState.phase === 'available' ? (
                <button
                  className="button button--primary button--compact"
                  onClick={() => void window.lookout.downloadAppUpdate()}
                  type="button"
                >
                  Download update
                </button>
              ) : null}
              {appUpdateState.phase === 'downloaded' ? (
                <button
                  className="button button--primary button--compact"
                  onClick={() => void window.lookout.installAppUpdate()}
                  type="button"
                >
                  Restart to install
                </button>
              ) : null}
              <button
                className="button button--ghost button--compact"
                onClick={() => setDismissedUpdateKey(updateNoticeKey)}
                type="button"
              >
                Later
              </button>
            </div>
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

        {spaceSwitcherOpen ? (
          <SpaceSwitcher
            activeSpaceId={activeSpaceId}
            onClose={() => setSpaceSwitcherOpen(false)}
            onSelect={(space) => {
              if (space.isOpen) {
                activateSpace(space.id);
                setSpaceSwitcherOpen(false);
                return;
              }

              void reopenSpace(space.id).then(() => setSpaceSwitcherOpen(false));
            }}
            spaces={projectSpaces}
          />
        ) : null}
      </div>
    </div>
  );
}

function SpaceSwitcher({
  spaces,
  activeSpaceId,
  onClose,
  onSelect,
}: {
  spaces: ProjectSpace[];
  activeSpaceId: string | null;
  onClose: () => void;
  onSelect: (space: ProjectSpace) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);

  const orderedSpaces = useMemo(
    () =>
      [...spaces].sort((left, right) => {
        if (left.isOpen !== right.isOpen) {
          return left.isOpen ? -1 : 1;
        }

        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }

        return right.updatedAt.localeCompare(left.updatedAt);
      }),
    [spaces],
  );

  const filteredSpaces = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return orderedSpaces.slice(0, 12);
    }

    return orderedSpaces
      .filter((space) => {
        const label = `${space.displayName} ${space.rootPath}`.toLowerCase();
        return label.includes(normalizedQuery);
      })
      .slice(0, 12);
  }, [deferredQuery, orderedSpaces]);
  const boundedSelectedIndex = filteredSpaces.length ? Math.min(selectedIndex, filteredSpaces.length - 1) : 0;

  return (
    <div
      className="space-switcher-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="space-switcher glass-card">
        <div className="space-switcher__header">
          <div className="space-switcher__title">
            <Search size={16} />
            <div>
              <span className="eyebrow">Quick Switch</span>
              <strong>Jump to any space</strong>
            </div>
          </div>
          <button className="button button--ghost button--compact" onClick={onClose} type="button">
            Esc
          </button>
        </div>

        <input
          autoFocus
          className="space-switcher__input"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((current) => Math.min(current + 1, Math.max(filteredSpaces.length - 1, 0)));
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((current) => Math.max(current - 1, 0));
            }

            if (event.key === 'Enter' && filteredSpaces[boundedSelectedIndex]) {
              event.preventDefault();
              onSelect(filteredSpaces[boundedSelectedIndex]);
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder="Search by project name or path"
          value={query}
        />

        <div className="space-switcher__list">
          {filteredSpaces.length ? (
            filteredSpaces.map((space, index) => {
              const isActive = space.id === activeSpaceId;
              const isSelected = index === boundedSelectedIndex;

              return (
                <button
                  key={space.id}
                  className={`space-switcher__item ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => onSelect(space)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  type="button"
                >
                  <div className="space-switcher__item-copy">
                    <strong>{space.displayName}</strong>
                    <span>{space.rootPath}</span>
                  </div>
                  <div className="space-switcher__item-meta">
                    {space.pinned ? <span className="space-switcher__pill">Pinned</span> : null}
                    <span className="space-switcher__pill">{space.isOpen ? 'Open' : 'Saved'}</span>
                    {isActive ? <span className="space-switcher__pill">Active</span> : null}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="space-switcher__empty">No spaces matched that search.</div>
          )}
        </div>
      </section>
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
