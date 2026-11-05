import { ChevronDown, ChevronUp, Copy, Download, Eye, EyeOff, Plus, RefreshCw, SquareTerminal, Star, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { SETTINGS_LIMITS } from '../../shared/settings-defaults';
import type { CloseOnExit, ColorScheme, CursorStyle, LookoutSettings, ProfileDefinition } from '../../shared/settings';
import { getState, pushToast, useApp } from '../../state/store';
import { allSchemes } from '../../terminal/theme';
import { bridge } from './bridge';
import { Field, Group, NumberField, SelectField, Switch, TextField } from './controls';
import { cx } from './filter';
import { FontPicker } from './FontPicker';
import { fontAdvice, useInstalledFonts } from './fonts';
import {
  duplicateProfile,
  formatEnvText,
  moveItem,
  parseEnvText,
  PROFILE_TEMPLATES,
  profileFromTemplate,
  profileKind,
  type ProfileKind,
  type ProfileTemplateId,
} from './helpers';
import { updateSettings } from './save';
import { useDebouncedCommit } from './use-debounced';

const KIND_LABEL: Record<ProfileKind, string> = { detected: 'detected', imported: 'imported', user: 'user' };

function patchProfile(id: string, mutate: (profile: ProfileDefinition, draft: LookoutSettings) => void): Promise<boolean> {
  return updateSettings((draft) => {
    const profile = draft.profiles.find((entry) => entry.id === id);
    if (!profile) return false;
    mutate(profile, draft);
  });
}

function setOptional<K extends keyof ProfileDefinition>(profile: ProfileDefinition, key: K, value: ProfileDefinition[K] | undefined): void {
  if (value === undefined || value === '') delete profile[key];
  else profile[key] = value;
}

function ProfileGlyph({ profile }: { profile: ProfileDefinition }) {
  return (
    <span className="settings-profile__icon" aria-hidden="true">
      {profile.icon ? profile.icon : <SquareTerminal size={13} />}
    </span>
  );
}

// ---- List -------------------------------------------------------------------------

export function ProfilesSection() {
  const settings = useApp((state) => state.settings);
  const { profiles, defaultProfile } = settings;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'detect' | 'import' | null>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles.find((profile) => profile.id === defaultProfile) ?? profiles[0];

  const visibleIndex = new Map<string, number>();
  for (const profile of profiles) {
    if (!profile.hidden) visibleIndex.set(profile.id, visibleIndex.size);
  }

  const move = (id: string, delta: number) =>
    void updateSettings((draft) => {
      const index = draft.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) return false;
      draft.profiles = moveItem(draft.profiles, index, delta);
    });

  const duplicate = (profile: ProfileDefinition) => {
    const copy = duplicateProfile(profile, getState().settings.profiles.map((entry) => entry.id));
    void updateSettings((draft) => {
      const index = draft.profiles.findIndex((entry) => entry.id === profile.id);
      draft.profiles.splice(index < 0 ? draft.profiles.length : index + 1, 0, copy);
    }).then((saved) => saved && setSelectedId(copy.id));
  };

  const remove = (profile: ProfileDefinition) => {
    const state = getState().settings;
    const index = state.profiles.findIndex((entry) => entry.id === profile.id);
    const wasDefault = state.defaultProfile === profile.id;
    if (index < 0 || state.profiles.length <= 1) return;
    void updateSettings((draft) => {
      draft.profiles = draft.profiles.filter((entry) => entry.id !== profile.id);
      if (draft.defaultProfile === profile.id) {
        draft.defaultProfile = (draft.profiles.find((entry) => !entry.hidden) ?? draft.profiles[0]).id;
      }
    }).then((saved) => {
      if (!saved) return;
      setSelectedId(null);
      pushToast({
        tone: 'info',
        title: `Deleted “${profile.name}”`,
        action: {
          label: 'Undo',
          run: () =>
            void updateSettings((draft) => {
              if (draft.profiles.some((entry) => entry.id === profile.id)) return false;
              draft.profiles.splice(Math.min(index, draft.profiles.length), 0, profile);
              if (wasDefault) draft.defaultProfile = profile.id;
            }),
        },
      });
    });
  };

  const detect = async () => {
    setBusy('detect');
    const before = new Set(getState().settings.profiles.map((profile) => profile.id));
    try {
      const next = await bridge().redetectProfiles();
      const added = next.profiles.filter((profile) => !before.has(profile.id));
      pushToast({
        tone: 'success',
        title: added.length ? `Found ${added.length} new ${added.length === 1 ? 'shell' : 'shells'}` : 'No new shells found',
        body: added.length ? added.map((profile) => profile.name).join(', ') : 'Shells that are gone were hidden; your edits were kept.',
      });
    } catch (error) {
      pushToast({ tone: 'error', title: 'Could not detect shells', body: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const importWt = async () => {
    setBusy('import');
    try {
      const { summary } = await bridge().importWindowsTerminal();
      pushToast({ tone: 'success', title: 'Imported from Windows Terminal', body: summary.length ? summary.join('\n') : 'Nothing new to import.', timeoutMs: 9000 });
    } catch (error) {
      pushToast({ tone: 'error', title: 'Could not import from Windows Terminal', body: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Group
        section="profiles"
        description="Order sets Ctrl+Shift+1…9 and the new-tab menu. Hidden profiles stay out of menus."
        actions={
          <>
            <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void detect()}>
              <RefreshCw size={13} className={cx(busy === 'detect' && 'settings-spin')} />
              Detect shells again
            </button>
            <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void importWt()}>
              <Download size={13} />
              Import from Windows Terminal
            </button>
          </>
        }
      >
        <ul className="settings-list" aria-label="Profiles">
          {profiles.map((profile, index) => {
            const kind = profileKind(profile.source);
            const isDefault = profile.id === defaultProfile;
            const isSelected = profile.id === selected?.id;
            const slot = visibleIndex.get(profile.id);
            return (
              <li key={profile.id} className={cx('settings-item', isSelected && 'is-selected', profile.hidden && 'is-muted')}>
                <button type="button" className="settings-item__main" aria-current={isSelected || undefined} onClick={() => setSelectedId(profile.id)}>
                  <ProfileGlyph profile={profile} />
                  <span className="settings-item__title truncate">{profile.name}</span>
                  <span className={cx('settings-badge', `settings-badge--${kind}`)}>{KIND_LABEL[kind]}</span>
                  {isDefault ? (
                    <span className="chip chip--accent settings-item__chip">
                      <Star size={10} />
                      default
                    </span>
                  ) : null}
                  {profile.elevate ? <span className="chip settings-item__chip">admin</span> : null}
                  <span className="settings-item__spacer" />
                  {slot !== undefined && slot < 9 ? <span className="settings-item__hint mono">Ctrl+Shift+{slot + 1}</span> : null}
                </button>
                <span className="settings-item__actions">
                  <button type="button" className="icon-btn icon-btn--sm" aria-label={`Move ${profile.name} up`} title="Move up" disabled={index === 0} onClick={() => move(profile.id, -1)}>
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={`Move ${profile.name} down`}
                    title="Move down"
                    disabled={index === profiles.length - 1}
                    onClick={() => move(profile.id, 1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  {!isDefault ? (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label={`Make ${profile.name} the default profile`}
                      title="Set as default"
                      onClick={() => void updateSettings((draft) => { draft.defaultProfile = profile.id; })}
                    >
                      <Star size={13} />
                    </button>
                  ) : null}
                  <button type="button" className="icon-btn icon-btn--sm" aria-label={`Duplicate ${profile.name}`} title="Duplicate" onClick={() => duplicate(profile)}>
                    <Copy size={13} />
                  </button>
                  {kind === 'user' ? (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm icon-btn--danger"
                      aria-label={`Delete ${profile.name}`}
                      title="Delete"
                      disabled={profiles.length <= 1}
                      onClick={() => remove(profile)}
                    >
                      <Trash2 size={13} />
                    </button>
                  ) : null}
                </span>
                <button
                  type="button"
                  className={cx('icon-btn icon-btn--sm settings-item__toggle', profile.hidden && 'is-active')}
                  aria-pressed={Boolean(profile.hidden)}
                  aria-label={profile.hidden ? `Show ${profile.name} in menus` : `Hide ${profile.name} from menus`}
                  title={profile.hidden ? 'Hidden from menus: click to show' : 'Hide from menus'}
                  onClick={() => void patchProfile(profile.id, (entry) => setOptional(entry, 'hidden', entry.hidden ? undefined : true))}
                >
                  {profile.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </li>
            );
          })}
        </ul>
        <AddProfile onAdded={setSelectedId} />
      </Group>

      {selected ? <ProfileEditor key={selected.id} profile={selected} settings={settings} isDefault={selected.id === defaultProfile} /> : null}
    </>
  );
}

// ---- Templates --------------------------------------------------------------------

function AddProfile({ onAdded }: { onAdded: (id: string) => void }) {
  const [pending, setPending] = useState<ProfileTemplateId | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const template = PROFILE_TEMPLATES.find((entry) => entry.id === pending);

  const add = (id: ProfileTemplateId, text: string) => {
    const result = profileFromTemplate(id, text, getState().settings.profiles.map((profile) => profile.id));
    if ('error' in result) {
      setError(result.error);
      return;
    }
    void updateSettings((draft) => { draft.profiles.push(result.profile); }).then((saved) => {
      if (!saved) return;
      setPending(null);
      setInput('');
      setError(null);
      onAdded(result.profile.id);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) add(pending, input);
  };

  if (template?.input) {
    return (
      <form className="settings-add settings-add--form" onSubmit={submit}>
        <label className="settings-add__label" htmlFor="settings-add-input">
          {template.label}: {template.input.label.toLowerCase()}
        </label>
        <input
          id="settings-add-input"
          className={cx('input input--mono', error && 'is-invalid')}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={input}
          placeholder={template.input.placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setPending(null);
            }
          }}
        />
        <button type="submit" className="btn btn--primary btn--sm">
          Add
        </button>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Cancel" onClick={() => setPending(null)}>
          <X size={13} />
        </button>
        {error ? (
          <span className="settings-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <div className="settings-add" role="group" aria-label="Add a profile">
      <span className="settings-add__label">
        <Plus size={13} />
        Add
      </span>
      {PROFILE_TEMPLATES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            if (entry.input) {
              setPending(entry.id);
              setInput('');
              setError(null);
            } else {
              add(entry.id, '');
            }
          }}
        >
          {entry.label}
          {entry.input ? '…' : ''}
        </button>
      ))}
    </div>
  );
}

// ---- Editor -----------------------------------------------------------------------

interface ProfileEditorProps {
  profile: ProfileDefinition;
  settings: LookoutSettings;
  isDefault: boolean;
}

function inheritLabel(value: string): string {
  return `Default (${value})`;
}

function ProfileEditor({ profile, settings, isDefault }: ProfileEditorProps) {
  const fonts = useInstalledFonts();
  const schemes: ColorScheme[] = allSchemes(settings);
  const id = profile.id;
  const kind = profileKind(profile.source);
  const advice = profile.font?.face ? fontAdvice(profile.font.face, fonts) : null;
  const patch = (mutate: (entry: ProfileDefinition) => void) => patchProfile(id, mutate);
  const envErrors = (text: string) => parseEnvText(text).errors[0] ?? null;

  return (
    <>
      <Group section="profiles" title={`Edit “${profile.name}”`}>
        {kind === 'detected' ? (
          <div className="settings-banner">Detected automatically. Your edits are kept when shells are detected again.</div>
        ) : null}
        <Field label="Name">
          {(controlId) => (
            <TextField
              id={controlId}
              width={260}
              value={profile.name}
              validate={(value) => (value.trim() ? null : 'A name is required.')}
              onCommit={(value) => patch((entry) => { entry.name = value.trim(); })}
            />
          )}
        </Field>
        <Field label="Icon" description="An emoji, a Nerd Font glyph or one or two letters.">
          {(controlId) => (
            <TextField id={controlId} width={72} maxLength={8} value={profile.icon ?? ''} placeholder="🐧" onCommit={(value) => patch((entry) => setOptional(entry, 'icon', value.trim()))} />
          )}
        </Field>
        <Field label="Command line" description="%VAR% references expand when the shell starts.">
          {(controlId) => (
            <TextField
              id={controlId}
              mono
              width={340}
              value={profile.commandline}
              validate={(value) => (value.trim() ? null : 'A command line is required.')}
              onCommit={(value) => patch((entry) => { entry.commandline = value.trim(); })}
            />
          )}
        </Field>
        <Field label="Starting directory" description="Empty starts in your home folder. ~ and %VAR% are expanded.">
          {(controlId) => (
            <TextField
              id={controlId}
              mono
              width={340}
              value={profile.startingDirectory ?? ''}
              placeholder="~"
              onCommit={(value) => patch((entry) => setOptional(entry, 'startingDirectory', value.trim()))}
            />
          )}
        </Field>
        <Field label="Startup command" description="Typed into the shell once it is ready.">
          {(controlId) => (
            <TextField
              id={controlId}
              mono
              width={340}
              value={profile.startupCommand ?? ''}
              placeholder="e.g. conda activate dev"
              onCommit={(value) => patch((entry) => setOptional(entry, 'startupCommand', value.trim()))}
            />
          )}
        </Field>
        <Field label="Tab color">
          {(controlId) => <ColorField id={controlId} value={profile.tabColor} onCommit={(value) => patch((entry) => setOptional(entry, 'tabColor', value))} />}
        </Field>
      </Group>

      <Group section="profiles" title="Appearance overrides">
        <Field label="Color scheme">
          {(controlId) => (
            <SelectField
              id={controlId}
              width={220}
              value={profile.colorScheme ?? ''}
              options={[{ value: '', label: inheritLabel(settings.colorScheme) }, ...schemes.map((scheme) => ({ value: scheme.name, label: scheme.name }))]}
              onChange={(value) => void patch((entry) => setOptional(entry, 'colorScheme', value))}
            />
          )}
        </Field>
        <Field label="Font face" note={advice ? <div className="settings-note settings-note--warn">{advice.message}</div> : null}>
          {(controlId) => (
            <FontPicker
              id={controlId}
              allowEmpty
              fonts={fonts}
              value={profile.font?.face ?? ''}
              placeholder={inheritLabel(settings.font.face)}
              onCommit={(face) =>
                patch((entry) => {
                  const font = { ...entry.font };
                  setOptionalFont(font, 'face', face || undefined);
                  setFont(entry, font);
                })
              }
            />
          )}
        </Field>
        <Field label="Font size">
          {(controlId) => (
            <NumberField
              id={controlId}
              optional
              suffix="px"
              step={0.5}
              value={profile.font?.size}
              placeholder={String(settings.font.size)}
              min={SETTINGS_LIMITS.fontSize.min}
              max={SETTINGS_LIMITS.fontSize.max}
              onCommit={(size) =>
                patch((entry) => {
                  const font = { ...entry.font };
                  setOptionalFont(font, 'size', size);
                  setFont(entry, font);
                })
              }
            />
          )}
        </Field>
        <Field label="Cursor shape">
          {(controlId) => (
            <SelectField<'' | CursorStyle>
              id={controlId}
              width={160}
              value={profile.cursorStyle ?? ''}
              options={[
                { value: '', label: inheritLabel(settings.terminal.cursorStyle) },
                { value: 'bar', label: 'Bar' },
                { value: 'block', label: 'Block' },
                { value: 'underline', label: 'Underline' },
              ]}
              onChange={(value) => void patch((entry) => setOptional(entry, 'cursorStyle', value || undefined))}
            />
          )}
        </Field>
        <Field label="Cursor blink">
          {(controlId) => (
            <SelectField<'' | 'on' | 'off'>
              id={controlId}
              width={160}
              value={profile.cursorBlink === undefined ? '' : profile.cursorBlink ? 'on' : 'off'}
              options={[
                { value: '', label: inheritLabel(settings.terminal.cursorBlink ? 'on' : 'off') },
                { value: 'on', label: 'Blink' },
                { value: 'off', label: 'Steady' },
              ]}
              onChange={(value) => void patch((entry) => setOptional(entry, 'cursorBlink', value ? value === 'on' : undefined))}
            />
          )}
        </Field>
      </Group>

      <Group section="profiles" title="Behavior">
        <Field label="Shell integration" description="Tracks the folder and marks commands. Turn off for shells that misbehave with it.">
          {(controlId) => (
            <Switch
              id={controlId}
              checked={profile.shellIntegration !== false}
              onChange={(value) => void patch((entry) => setOptional(entry, 'shellIntegration', value ? undefined : false))}
            />
          )}
        </Field>
        <Field label="When the shell exits">
          {(controlId) => (
            <SelectField<'' | CloseOnExit>
              id={controlId}
              width={200}
              value={profile.closeOnExit ?? ''}
              options={[
                { value: '', label: inheritLabel(settings.terminal.closeOnExit) },
                { value: 'graceful', label: 'Close if it succeeded' },
                { value: 'always', label: 'Always close' },
                { value: 'never', label: 'Keep the pane open' },
              ]}
              onChange={(value) => void patch((entry) => setOptional(entry, 'closeOnExit', value || undefined))}
            />
          )}
        </Field>
        <Field label="Run as administrator" description="Opens in an elevated Lookout window after a UAC prompt.">
          {(controlId) => <Switch id={controlId} checked={Boolean(profile.elevate)} onChange={(value) => void patch((entry) => setOptional(entry, 'elevate', value || undefined))} />}
        </Field>
        {!isDefault ? (
          <Field label="Default profile" description="Used for new tabs and the lookout command.">
            <button type="button" className="btn btn--sm" onClick={() => void updateSettings((draft) => { draft.defaultProfile = id; })}>
              Make default
            </button>
          </Field>
        ) : null}
      </Group>

      <Group section="profiles" title="Environment variables">
        <Field
          stacked
          label="Variables"
          description={
            <>
              One <span className="mono">KEY=VALUE</span> per line; <span className="mono">#</span> starts a comment. settings.json is plain text, so keep
              secrets out of it and load them from your secret store in the startup command instead.
            </>
          }
        >
          {(controlId) => (
            <TextField
              id={controlId}
              multiline
              rows={4}
              width="100%"
              value={formatEnvText(profile.env)}
              placeholder={'NODE_ENV=development\nPATH=%PATH%;C:\\tools'}
              validate={envErrors}
              onCommit={(text) =>
                patch((entry) => {
                  const { env } = parseEnvText(text);
                  if (Object.keys(env).length) entry.env = env;
                  else delete entry.env;
                })
              }
            />
          )}
        </Field>
      </Group>
    </>
  );
}

type FontOverride = NonNullable<ProfileDefinition['font']>;

function setOptionalFont<K extends keyof FontOverride>(font: FontOverride, key: K, value: FontOverride[K] | undefined): void {
  if (value === undefined) delete font[key];
  else font[key] = value;
}

function setFont(profile: ProfileDefinition, font: FontOverride): void {
  if (Object.keys(font).length) profile.font = font;
  else delete profile.font;
}

// ---- Color ------------------------------------------------------------------------

function ColorField({ id, value, onCommit }: { id: string; value: string | undefined; onCommit: (value: string | undefined) => unknown }) {
  const [draft, setDraft] = useState<string | null>(null);
  const { schedule, flush } = useDebouncedCommit<string | undefined>();
  const shown = draft ?? value ?? '';
  return (
    <span className="settings-inline">
      <input
        id={id}
        type="color"
        className="settings-color"
        value={/^#[\da-f]{6}$/i.test(shown) ? shown : '#f0883e'}
        onChange={(event) => {
          setDraft(event.target.value);
          schedule(event.target.value, onCommit);
        }}
        onBlur={() => void flush().then(() => setDraft(null))}
      />
      <span className="mono faint">{shown || 'None'}</span>
      {value ? (
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Clear tab color" title="Clear" onClick={() => void onCommit(undefined)}>
          <X size={13} />
        </button>
      ) : null}
    </span>
  );
}
