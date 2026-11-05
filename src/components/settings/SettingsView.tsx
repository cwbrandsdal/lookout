import { Braces, ChevronRight, FileCode, Info, Keyboard, Layers, Palette, Plug, Search, SlidersHorizontal, SquareTerminal, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { patchUi, useApp } from '../../state/store';
import { AboutSection } from './AboutSection';
import { AppearanceSection } from './AppearanceSection';
import { bridge } from './bridge';
import { isSectionId, matchRows, rowMeta, SECTIONS, type RowId, type SectionId } from './catalog';
import { Field } from './controls';
import { cx, FilterContext, RECORDING_ATTRIBUTE, sectionHasMatches } from './filter';
import { GeneralSection } from './GeneralSection';
import { IntegrationsSection } from './IntegrationsSection';
import { KeyboardSection } from './KeyboardSection';
import { buildVariants, variantMatches } from './keyboard-model';
import { ProfilesSection } from './ProfilesSection';
import { SnippetsSection } from './SnippetsSection';
import { TerminalSection } from './TerminalSection';

const ICONS: Record<SectionId, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  terminal: SquareTerminal,
  profiles: Layers,
  keyboard: Keyboard,
  snippets: Braces,
  integrations: Plug,
  about: Info,
};

const SECTION_VIEWS: Record<SectionId, () => JSX.Element> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  terminal: TerminalSection,
  profiles: ProfilesSection,
  keyboard: () => <KeyboardSection />,
  snippets: SnippetsSection,
  integrations: IntegrationsSection,
  about: AboutSection,
};

/** List sections can't be filtered row by row; search links to them instead. */
const JUMP_ROWS: Partial<Record<SectionId, RowId>> = {
  profiles: 'profiles.list',
  keyboard: 'keyboard.shortcuts',
  snippets: 'snippets.list',
};

function close(): void {
  patchUi({ settingsOpen: false });
}

export function SettingsView(): JSX.Element {
  const { section, warnings } = useApp(useShallow((state) => ({ section: state.ui.settingsSection, warnings: state.settingsWarnings })));
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const active: SectionId = isSectionId(section) ? section : 'general';
  const searching = query.trim().length > 0;
  const results = useSearch(query);

  useEffect(() => {
    // Keep keystrokes away from a terminal that still has focus behind settings.
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.documentElement.hasAttribute(RECORDING_ATTRIBUTE)) return;
      const { ui } = useApp.getState();
      if (ui.dialog || ui.palette || ui.contextMenu) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const go = (id: SectionId) => {
    setQuery('');
    patchUi({ settingsSection: id });
    scroller.current?.scrollTo({ top: 0 });
  };

  const ActiveSection = SECTION_VIEWS[active];
  const title = searching ? 'Search' : (SECTIONS.find((entry) => entry.id === active)?.title ?? 'Settings');

  return (
    <div className="settings" ref={root} tabIndex={-1} aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav__search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            className="settings-nav__input"
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
        </div>
        <ul className="settings-nav__list">
          {SECTIONS.map((entry) => {
            const Icon = ICONS[entry.id];
            const count = searching ? results.counts[entry.id] : 0;
            const isActive = !searching && entry.id === active;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={cx('settings-nav__item', isActive && 'is-active', searching && !count && 'is-dim')}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => go(entry.id)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="truncate">{entry.title}</span>
                  {searching && count ? <span className="settings-nav__count">{count}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="settings-nav__file" onClick={() => bridge().openSettingsFile()}>
          <FileCode size={13} aria-hidden="true" />
          Open settings.json
        </button>
      </nav>

      <div className="settings-main">
        <header className="settings-header">
          <h1 className="settings-header__title">{title}</h1>
          <span className="settings-header__hint faint">
            <kbd className="kbd">Esc</kbd> to close
          </span>
          <button type="button" className="icon-btn" aria-label="Close settings" title="Close settings" onClick={close}>
            <X size={14} />
          </button>
        </header>
        <div className="settings-scroll" ref={scroller}>
          <div className="settings-content">
            {warnings.length ? <SettingsWarnings warnings={warnings} /> : null}
            {searching ? <SearchResults query={query} results={results} onJump={go} /> : <ActiveSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Search -----------------------------------------------------------------------

interface SearchState {
  matches: ReadonlySet<RowId>;
  keyboardMatches: number;
  counts: Record<SectionId, number>;
  total: number;
}

function useSearch(query: string): SearchState {
  const { keybindings, profiles, snippets, workspaces } = useApp(
    useShallow((state) => ({
      keybindings: state.settings.keybindings,
      profiles: state.settings.profiles,
      snippets: state.settings.snippets,
      workspaces: state.workspaces,
    })),
  );

  return useMemo(() => {
    const matches = matchRows(query);
    const counts = Object.fromEntries(SECTIONS.map((entry) => [entry.id, 0])) as Record<SectionId, number>;
    for (const id of matches) counts[rowMeta(id).section] += 1;

    let keyboardMatches = 0;
    if (query.trim()) {
      const variants = buildVariants(keybindings, { profiles: profiles.filter((profile) => !profile.hidden), snippets, workspaces });
      keyboardMatches = variants.filter((variant) => variantMatches(variant, query)).length;
      counts.keyboard += keyboardMatches;
    }
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { matches, keyboardMatches, counts, total };
  }, [query, keybindings, profiles, snippets, workspaces]);
}

function SearchResults({ query, results, onJump }: { query: string; results: SearchState; onJump: (id: SectionId) => void }) {
  const filter = useMemo(() => ({ query, matches: results.matches }), [query, results.matches]);
  if (!results.total) {
    return <div className="settings-empty">No settings match “{query.trim()}”.</div>;
  }

  return (
    <FilterContext.Provider value={filter}>
      {SECTIONS.map((entry) => {
        const jump = JUMP_ROWS[entry.id];
        const hasRows = sectionHasMatches(results.matches, entry.id);
        const hasKeys = entry.id === 'keyboard' && results.keyboardMatches > 0;
        if (!hasRows && !hasKeys) return null;
        const View = SECTION_VIEWS[entry.id];
        return (
          <section key={entry.id} className="settings-result" aria-label={entry.title}>
            <h2 className="settings-result__title">{entry.title}</h2>
            {jump && hasRows ? (
              <div className="settings-panel">
                <Field label={rowMeta(jump).label} description={rowMeta(jump).description}>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => onJump(entry.id)}>
                    Open {entry.title}
                    <ChevronRight size={13} />
                  </button>
                </Field>
              </div>
            ) : null}
            {hasKeys ? <KeyboardSection query={query} /> : null}
            {!jump ? <View /> : null}
          </section>
        );
      })}
    </FilterContext.Provider>
  );
}

function SettingsWarnings({ warnings }: { warnings: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-banner settings-banner--warn" role="status">
      <TriangleAlert size={13} aria-hidden="true" />
      <div className="settings-banner__body">
        <span>
          settings.json has {warnings.length === 1 ? 'a value' : `${warnings.length} values`} Lookout couldn’t use; defaults are in effect for{' '}
          {warnings.length === 1 ? 'it' : 'them'}.
        </span>
        {open ? (
          <ul className="settings-banner__list mono">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className="settings-banner__actions">
        <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open ? 'Hide' : 'Details'}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => bridge().openSettingsFile()}>
          Open file
        </button>
      </span>
    </div>
  );
}
