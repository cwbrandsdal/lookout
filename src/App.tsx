import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import lookoutLogo from './assets/lookout-app-icon.png';
import { Overlays } from './components/overlays/Overlays';
import { PaneDragLayer } from './components/PaneDragLayer';
import { PaneGrid } from './components/PaneGrid';
import { SettingsView } from './components/settings/SettingsView';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useApp } from './state/store';
import { resolveAppTheme } from './terminal/theme';

export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}

function useThemeAttribute(): void {
  const appTheme = useApp((state) => state.settings.appTheme);
  const darkTheme = useApp((state) => state.settings.darkTheme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveAppTheme(useApp.getState().settings);
      document.documentElement.dataset.darkTheme = darkTheme;
    };
    apply();
    const query = window.matchMedia('(prefers-color-scheme: light)');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [appTheme, darkTheme]);
}

function Shell() {
  useThemeAttribute();
  const { ready, bootError, tabs, activeTabId, settingsOpen, elevated, windowKind, sidebarCollapsed, sidebarWidth } = useApp(
    useShallow((state) => ({
      ready: state.ready,
      bootError: state.bootError,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      settingsOpen: state.ui.settingsOpen,
      elevated: state.elevated,
      windowKind: state.windowKind,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
    })),
  );

  if (bootError) {
    return <BootScreen message={bootError} error />;
  }
  if (!ready) {
    return <BootScreen message="Starting…" />;
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const classes = ['shell', elevated ? 'is-admin' : '', windowKind === 'quake' ? 'is-quake' : '', sidebarCollapsed ? 'is-rail' : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ ['--sidebar-w' as string]: `${sidebarCollapsed ? 48 : sidebarWidth}px` }}>
      <Sidebar />
      <main className="shell__main">
        <TopBar />
        <div className="shell__stage">
          {activeTab ? <PaneGrid key={activeTab.id} tab={activeTab} /> : null}
          {settingsOpen ? (
            <div className="shell__settings">
              <SettingsView />
            </div>
          ) : null}
        </div>
      </main>
      <PaneDragLayer />
      <Overlays />
    </div>
  );
}

function BootScreen({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <div className="boot drag">
      <img alt="" className="boot__logo" src={lookoutLogo} />
      <span className={error ? 'boot__error' : 'boot__message'}>{message}</span>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Lookout renderer crashed', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot drag">
          <img alt="" className="boot__logo" src={lookoutLogo} />
          <span className="boot__error">Something broke: {this.state.error.message}</span>
          <button className="btn no-drag" onClick={() => window.location.reload()} type="button">
            Reload window (shells keep running)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
