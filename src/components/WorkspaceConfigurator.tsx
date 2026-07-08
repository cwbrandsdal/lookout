import { useMemo, useState } from 'react';
import { FolderOpen, Rocket, Save, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../store/useAppStore';
import {
  LAYOUT_TEMPLATES,
  deriveDisplayNameFromPath,
  getDefaultStartupCommandForRole,
  getLayoutTemplate,
  getRoleDefinition,
  getYoloStartupCommand,
  isYoloStartupCommand,
  supportsYoloMode,
} from '../types/app';

export function WorkspaceConfigurator() {
  const {
    draft,
    draftMode,
    presets,
    roles,
    projectSpaces,
    settings,
    updateDraft,
    setDraftLayout,
    updateDraftPane,
    applyPresetToDraft,
    saveDraftAsPreset,
    updatePresetFromDraft,
    deletePreset,
    saveDraftToProjectSpace,
    reopenSpace,
    activateSpace,
    updateSettings,
  } = useAppStore(
    useShallow((state) => ({
      draft: state.draft,
      draftMode: state.draftMode,
      presets: state.presets,
      roles: state.roles,
      projectSpaces: state.projectSpaces,
      settings: state.settings,
      updateDraft: state.updateDraft,
      setDraftLayout: state.setDraftLayout,
      updateDraftPane: state.updateDraftPane,
      applyPresetToDraft: state.applyPresetToDraft,
      saveDraftAsPreset: state.saveDraftAsPreset,
      updatePresetFromDraft: state.updatePresetFromDraft,
      deletePreset: state.deletePreset,
      saveDraftToProjectSpace: state.saveDraftToProjectSpace,
      reopenSpace: state.reopenSpace,
      activateSpace: state.activateSpace,
      updateSettings: state.updateSettings,
    })),
  );

  const [pathMessage, setPathMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');

  const selectedPreset = presets.find((preset) => preset.id === draft.presetId) ?? null;
  const sortedSpaces = useMemo(
    () => [...projectSpaces].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8),
    [projectSpaces],
  );

  async function handleBrowse() {
    const selected = await window.lookout.pickDirectory(draft.rootPath || undefined);
    if (!selected) {
      return;
    }

    updateDraft({
      rootPath: selected,
      displayName: draft.displayName.trim() || deriveDisplayNameFromPath(selected),
    });
    setPathMessage(null);
  }

  async function handleLaunch() {
    setSubmitting(true);
    try {
      const validation = await window.lookout.validateDirectory(draft.rootPath.trim());
      if (!validation.valid || !validation.normalizedPath) {
        setPathMessage(validation.error ?? 'Select a valid folder path before launching the workspace.');
        return;
      }

      updateDraft({
        rootPath: validation.normalizedPath,
        displayName: draft.displayName.trim() || deriveDisplayNameFromPath(validation.normalizedPath),
      });

      await saveDraftToProjectSpace();
      setPathMessage(null);
    } finally {
      setSubmitting(false);
    }
  }

  const layout = getLayoutTemplate(draft.layoutTemplateId);

  return (
    <section className="page-view">
      <div className="page">
        <header className="page__bar">
          <div className="page__bar-copy">
            <h1>{draftMode === 'edit' ? 'Edit project space' : 'New project space'}</h1>
            <p className="page__bar-meta">
              {draft.rootPath || 'No folder selected'} · {layout.name} · {draft.paneDefinitions.length}{' '}
              {draft.paneDefinitions.length === 1 ? 'pane' : 'panes'}
            </p>
          </div>
          <div className="page__bar-actions no-drag">
            <button className="button button--primary" disabled={submitting} onClick={handleLaunch} type="button">
              <Rocket size={14} />
              {draftMode === 'edit' ? 'Save space' : 'Launch space'}
            </button>
          </div>
        </header>

        <section className="card">
          <div className="card__header">
            <h2>Project</h2>
            <p>Root folder and name for this space</p>
          </div>

          <div className="path-row">
            <label className="field">
              <span className="field__label">Folder path</span>
              <input
                className="field__input"
                onChange={(event) => updateDraft({ rootPath: event.target.value })}
                placeholder="D:\\Projects\\SampleApp"
                value={draft.rootPath}
              />
            </label>
            <button className="button" onClick={handleBrowse} type="button">
              <FolderOpen size={14} />
              Browse
            </button>
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field__label">Project name</span>
              <input
                className="field__input"
                onChange={(event) => updateDraft({ displayName: event.target.value })}
                placeholder={draft.rootPath ? deriveDisplayNameFromPath(draft.rootPath) : 'SampleApp'}
                value={draft.displayName}
              />
            </label>
          </div>

          {settings.recentProjectPaths.length ? (
            <div className="chip-row">
              {settings.recentProjectPaths.map((entry) => (
                <button
                  key={entry}
                  className="chip"
                  onClick={() =>
                    updateDraft({
                      rootPath: entry,
                      displayName: draft.displayName.trim() || deriveDisplayNameFromPath(entry),
                    })
                  }
                  title={entry}
                  type="button"
                >
                  {entry}
                </button>
              ))}
            </div>
          ) : null}

          {pathMessage ? <p className="field__message field__message--error">{pathMessage}</p> : null}
        </section>

        <section className="card">
          <div className="card__header">
            <h2>Layout</h2>
            <p>How the terminal grid is split</p>
          </div>

          <div className="layout-grid">
            {LAYOUT_TEMPLATES.map((template) => {
              const isActive = template.id === draft.layoutTemplateId;
              return (
                <button
                  key={template.id}
                  className={`layout-card ${isActive ? 'is-active' : ''}`}
                  onClick={() => setDraftLayout(template.id)}
                  type="button"
                >
                  <div
                    className="layout-card__glyph"
                    style={{
                      gridTemplateColumns: `repeat(${template.columns}, 1fr)`,
                      gridTemplateRows: `repeat(${template.rows}, 1fr)`,
                    }}
                  >
                    {Array.from({ length: template.count }).map((_, index) => (
                      <span key={`${template.id}-${index}`} />
                    ))}
                  </div>
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2>Panes</h2>
            <p>Agent, path, and startup for each terminal</p>
          </div>

          <div className="pane-editor-list">
            {draft.paneDefinitions.map((pane, index) => {
              const role = getRoleDefinition(pane.roleId, roles);
              const yoloSupported = supportsYoloMode(role.id);
              const yoloStartupCommand = getYoloStartupCommand(role.id);
              const yoloEnabled = isYoloStartupCommand(role.id, pane.startupCommand ?? role.defaultStartupCommand);
              return (
                <article key={pane.id} className="pane-editor">
                  <div className="pane-editor__heading">
                    <div className="pane-editor__heading-copy">
                      <span className="eyebrow">Pane {index + 1}</span>
                      <h3>{pane.title || role.displayName}</h3>
                    </div>
                    <span className="pane-editor__role-pill" style={{ color: role.accent }}>
                      {role.displayName}
                    </span>
                  </div>

                  <div className="pane-editor__grid">
                    <label className="field">
                      <span className="field__label">Title</span>
                      <input
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { title: event.target.value })}
                        value={pane.title}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">Role / agent</span>
                      <select
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { roleId: event.target.value })}
                        value={pane.roleId}
                      >
                        {roles.map((availableRole) => (
                          <option key={availableRole.id} value={availableRole.id}>
                            {availableRole.displayName}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field__label">Working directory override</span>
                      <input
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { workingDirectory: event.target.value })}
                        placeholder="src\\app"
                        value={pane.workingDirectory ?? ''}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">Startup command</span>
                      <input
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { startupCommand: event.target.value })}
                        placeholder={role.defaultStartupCommand ?? 'Optional'}
                        value={pane.startupCommand ?? ''}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">Executable override</span>
                      <input
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { executable: event.target.value })}
                        placeholder="pwsh"
                        value={pane.executable ?? ''}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">Shell args</span>
                      <input
                        className="field__input"
                        onChange={(event) => updateDraftPane(pane.id, { arguments: splitArguments(event.target.value) })}
                        placeholder="-NoLogo"
                        value={pane.arguments.join(' ')}
                      />
                    </label>
                  </div>

                  {yoloSupported && yoloStartupCommand ? (
                    <div className="pane-editor__inline-options">
                      <label className="toggle">
                        <input
                          checked={yoloEnabled}
                          onChange={(event) =>
                            updateDraftPane(pane.id, {
                              startupCommand: getDefaultStartupCommandForRole(role.id, event.target.checked, roles) ?? '',
                            })
                          }
                          type="checkbox"
                        />
                        <span>YOLO mode for {role.displayName}</span>
                      </label>
                      <p className="muted-copy">{yoloStartupCommand}</p>
                    </div>
                  ) : null}

                  <div className="pane-editor__grid pane-editor__grid--single">
                    <label className="field">
                      <span className="field__label">Environment variables</span>
                      <textarea
                        className="field__input field__input--textarea"
                        onChange={(event) => updateDraftPane(pane.id, { envVars: parseEnvText(event.target.value) })}
                        placeholder={'OPENAI_API_KEY=\nNODE_ENV=development'}
                        value={stringifyEnvText(pane.envVars)}
                      />
                    </label>
                  </div>

                  <label className="toggle">
                    <input
                      checked={pane.autoStart}
                      onChange={(event) => updateDraftPane(pane.id, { autoStart: event.target.checked })}
                      type="checkbox"
                    />
                    <span>Auto-start this pane when the space opens</span>
                  </label>
                </article>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2>Presets</h2>
            <p>Reusable layout and pane recipes</p>
          </div>

          {presets.length ? (
            <div className="preset-list">
              {presets.map((preset) => (
                <div key={preset.id} className={`preset-row ${preset.id === draft.presetId ? 'is-active' : ''}`}>
                  <div className="preset-row__copy">
                    <strong>{preset.name}</strong>
                    <span>{preset.description}</span>
                  </div>
                  <span className="preset-row__meta">
                    {getLayoutTemplate(preset.layoutTemplateId).name} · {preset.paneDefinitions.length}{' '}
                    {preset.paneDefinitions.length === 1 ? 'pane' : 'panes'}
                  </span>
                  <div className="preset-row__actions">
                    <button className="button button--compact" onClick={() => applyPresetToDraft(preset.id)} type="button">
                      Use
                    </button>
                    <button
                      className="icon-button icon-button--danger"
                      onClick={() => deletePreset(preset.id)}
                      title="Delete preset"
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No presets yet. Save the current configuration below to reuse it later.</p>
          )}

          <div className="preset-save">
            <label className="field">
              <span className="field__label">Preset name</span>
              <input className="field__input" onChange={(event) => setPresetName(event.target.value)} value={presetName} />
            </label>
            <label className="field">
              <span className="field__label">Description</span>
              <input
                className="field__input"
                onChange={(event) => setPresetDescription(event.target.value)}
                value={presetDescription}
              />
            </label>
            <div className="preset-save__actions">
              <button
                className="button"
                onClick={() => {
                  const created = saveDraftAsPreset(presetName, presetDescription);
                  if (created) {
                    setPresetName('');
                    setPresetDescription('');
                  }
                }}
                type="button"
              >
                <Save size={14} />
                Save as preset
              </button>
              {selectedPreset ? (
                <button
                  className="button button--ghost"
                  onClick={() => updatePresetFromDraft(selectedPreset.id, presetName || undefined, presetDescription || undefined)}
                  type="button"
                >
                  Update selected
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <h2>Saved spaces</h2>
            <p>Reopen a space that is not in the sidebar</p>
          </div>

          {sortedSpaces.length ? (
            <div className="saved-list">
              {sortedSpaces.map((space) => (
                <div key={space.id} className="saved-row">
                  <div className="saved-row__copy">
                    <strong>{space.displayName}</strong>
                    <span>{space.rootPath}</span>
                  </div>
                  {space.isOpen ? (
                    <button className="button button--compact" onClick={() => activateSpace(space.id)} type="button">
                      Open tab
                    </button>
                  ) : (
                    <button className="button button--compact" onClick={() => void reopenSpace(space.id)} type="button">
                      Reopen
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-copy">Saved project spaces appear here after you launch your first one.</p>
          )}
        </section>

        <section className="card">
          <div className="card__header">
            <h2>Behavior</h2>
            <p>App-wide startup options</p>
          </div>

          <label className="toggle">
            <input
              checked={settings.restoreOpenProjectSpaces}
              onChange={(event) => updateSettings({ restoreOpenProjectSpaces: event.target.checked })}
              type="checkbox"
            />
            <span>Restore open project spaces on next app launch</span>
          </label>

          <label className="toggle">
            <input
              checked={settings.rememberRecentProjectPaths}
              onChange={(event) => updateSettings({ rememberRecentProjectPaths: event.target.checked })}
              type="checkbox"
            />
            <span>Remember recent project root paths</span>
          </label>
        </section>
      </div>
    </section>
  );
}

function splitArguments(input: string): string[] {
  return input
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvText(input: string): Record<string, string> {
  return input.split(/\r?\n/).reduce<Record<string, string>>((accumulator, line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return accumulator;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      return accumulator;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (key) {
      accumulator[key] = value;
    }
    return accumulator;
  }, {});
}

function stringifyEnvText(envVars: Record<string, string>): string {
  return Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
