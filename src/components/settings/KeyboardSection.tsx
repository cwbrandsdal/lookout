import { Plus, RotateCcw, Search, X } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { isCommandId } from '../../shared/commands';
import { getState, useApp } from '../../state/store';
import { resolveKeymap } from '../../terminal/keymap';
import { acceleratorToChord, captureChord, chordParts } from './chords';
import { Keys } from './controls';
import { cx } from './filter';
import {
  addChord,
  buildVariants,
  findConflicts,
  removeChord,
  resetVariant,
  variantKey,
  variantMatches,
  type CommandVariant,
} from './keyboard-model';
import { KeyRecorder } from './recorder';
import { updateSettings } from './save';

interface PendingReplace {
  variant: CommandVariant;
  chord: string;
  currentTitle: string;
}

interface KeyboardSectionProps {
  /** Global settings search; hides the local search box and notes when set. */
  query?: string;
}

export function KeyboardSection({ query: externalQuery }: KeyboardSectionProps) {
  const { keybindings, profiles, snippets, workspaces, quake, summonHotkey } = useApp(
    useShallow((state) => ({
      keybindings: state.settings.keybindings,
      profiles: state.settings.profiles,
      snippets: state.settings.snippets,
      workspaces: state.workspaces,
      quake: state.settings.quake,
      summonHotkey: state.settings.window.summonHotkey,
    })),
  );
  const [localQuery, setLocalQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReplace | null>(null);
  const query = externalQuery ?? localQuery;

  const variants = useMemo(
    () => buildVariants(keybindings, { profiles: profiles.filter((profile) => !profile.hidden), snippets, workspaces }),
    [keybindings, profiles, snippets, workspaces],
  );
  const conflicts = useMemo(() => {
    const hotkeys: Array<{ chord: string; label: string }> = [];
    if (quake.enabled) hotkeys.push({ chord: acceleratorToChord(quake.hotkey), label: 'drop-down hotkey' });
    if (summonHotkey) hotkeys.push({ chord: acceleratorToChord(summonHotkey), label: 'summon hotkey' });
    const byVariant = new Map<string, string[]>();
    for (const conflict of findConflicts(keybindings, variants, hotkeys)) {
      byVariant.set(conflict.variantKey, [...(byVariant.get(conflict.variantKey) ?? []), conflict.message]);
    }
    return byVariant;
  }, [keybindings, variants, quake, summonHotkey]);

  const shown = (query.trim() ? variants.filter((variant) => variantMatches(variant, query)) : variants).map((variant, index, list) => ({
    variant,
    header: index === 0 || list[index - 1].category !== variant.category ? variant.category : null,
  }));
  const titleByKey = useMemo(() => new Map(variants.map((variant) => [variant.key, variant.title])), [variants]);

  const capture = (variant: CommandVariant, chord: string) => {
    setRecording(null);
    const current = resolveKeymap(getState().settings.keybindings, isCommandId).get(chord);
    if (current && variantKey(current.command, current.args) === variant.key) return;
    if (current) {
      setPending({ variant, chord, currentTitle: titleByKey.get(variantKey(current.command, current.args)) ?? current.command });
      return;
    }
    void updateSettings((draft) => { draft.keybindings = addChord(draft.keybindings, chord, variant.command, variant.args); });
  };

  const confirmReplace = () => {
    if (!pending) return;
    const { variant, chord } = pending;
    setPending(null);
    void updateSettings((draft) => { draft.keybindings = addChord(draft.keybindings, chord, variant.command, variant.args); });
  };

  return (
    <div className="settings-keyboard">
      {externalQuery === undefined ? (
        <>
          <p className="settings-group__desc">
            <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">C</kbd> copies only when text is selected and <kbd className="kbd">Ctrl</kbd>+
            <kbd className="kbd">V</kbd> pastes only when the clipboard has text; otherwise both keys go to the shell. AltGr combinations are never
            shortcuts, so @ {'{'} [ ] {'}'} \ $ always reach the shell.
          </p>
          <div className="settings-keyboard__search">
            <Search size={13} aria-hidden="true" />
            <input
              className="input"
              type="search"
              placeholder="Search commands or keys"
              aria-label="Search commands or keys"
              value={localQuery}
              onChange={(event) => setLocalQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && localQuery) {
                  event.preventDefault();
                  event.stopPropagation();
                  setLocalQuery('');
                }
              }}
            />
          </div>
        </>
      ) : null}

      {pending ? (
        <div className="settings-banner settings-banner--warn" role="alertdialog" aria-label="Shortcut already in use">
          <span>
            <Keys parts={chordParts(pending.chord)} /> already runs <strong>{pending.currentTitle}</strong>. Move it to <strong>{pending.variant.title}</strong>?
          </span>
          <span className="settings-banner__actions">
            <button type="button" className="btn btn--primary btn--sm" autoFocus onClick={confirmReplace}>
              Replace
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </span>
        </div>
      ) : null}

      {shown.length ? (
        <div className="settings-panel settings-keytable" role="table" aria-label="Keyboard shortcuts">
          {shown.map(({ variant, header }) => {
            const notes = conflicts.get(variant.key);
            const isRecording = recording === variant.key;
            return (
              <Fragment key={variant.key}>
                {header ? (
                  <div className="settings-keytable__category" role="row">
                    <span role="columnheader">{header}</span>
                  </div>
                ) : null}
                <div className={cx('settings-keyrow', isRecording && 'is-recording')} role="row">
                  <div className="settings-keyrow__title" role="cell">
                    <span className="truncate" title={variant.command}>
                      {variant.title}
                    </span>
                    {variant.modified ? <span className="dot dot--accent" title="Changed from the default" aria-label="Changed" /> : null}
                    {notes?.map((note) => (
                      <span key={note} className="settings-keyrow__conflict">
                        {note}
                      </span>
                    ))}
                  </div>
                  <div className="settings-keyrow__keys" role="cell">
                    {variant.chords.map((chord) => (
                      <span key={chord} className="settings-chord">
                        <Keys parts={chordParts(chord)} />
                        <button
                          type="button"
                          className="settings-chord__remove"
                          aria-label={`Remove ${chordParts(chord).join('+')} from ${variant.title}`}
                          title="Remove"
                          onClick={() => void updateSettings((draft) => { draft.keybindings = removeChord(draft.keybindings, chord); })}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    {isRecording ? (
                      <KeyRecorder capture={captureChord} onCancel={() => setRecording(null)} onCapture={(chord) => capture(variant, chord)} />
                    ) : (
                      <span className="settings-keyrow__actions">
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          aria-label={`Add a shortcut to ${variant.title}`}
                          title="Add shortcut"
                          onClick={() => {
                            setPending(null);
                            setRecording(variant.key);
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        {variant.modified ? (
                          <button
                            type="button"
                            className="icon-btn icon-btn--sm"
                            aria-label={`Reset ${variant.title} to its default shortcuts`}
                            title="Reset to default"
                            onClick={() => void updateSettings((draft) => { draft.keybindings = resetVariant(draft.keybindings, variant.command, variant.args); })}
                          >
                            <RotateCcw size={12} />
                          </button>
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="settings-empty">No commands match “{query}”.</div>
      )}
    </div>
  );
}
