import { useMemo, useState } from 'react';
import { FolderOpen, LayoutGrid, Rocket, Save, Sparkles } from 'lucide-react';
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
    <section className="configurator">
      <div className="configurator__hero glass-card">
        <div className="configurator__hero-copy">
          <span className="eyebrow">Configure Layout</span>
          <h1>{draftMode === 'edit' ? 'Refine project space' : 'Configure project space'}</h1>
          <p>
            Choose the project root, select a layout template, assign agent lanes, and launch a real PowerShell-backed
            workspace.
          </p>
        </div>

        <div className="configurator__hero-summary">
          <div className="summary-pill">
            <LayoutGrid size={16} />
            <span>{layout.name}</span>
          </div>
          <div className="summary-pill">
            <Sparkles size={16} />
            <span>{draft.paneDefinitions.length} panes</span>
          </div>
          <div className="summary-pill">
            <FolderOpen size={16} />
            <span>{draft.rootPath || 'No folder selected'}</span>
          </div>
        </div>
      </div>

      <div className="configurator__grid">
        <div className="configurator__main">
          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Working Directory</span>
                <h2>Project root</h2>
              </div>
            </div>

            <div className="path-picker">
              <label className="field">
                <span className="field__label">Folder path</span>
                <input
                  className="field__input"
                  onChange={(event) => updateDraft({ rootPath: event.target.value })}
                  placeholder="D:\\Projects\\SampleApp"
                  value={draft.rootPath}
                />
              </label>
              <button className="button button--secondary" onClick={handleBrowse} type="button">
                Browse
              </button>
            </div>

            <div className="path-picker">
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

            {pathMessage ? <p className="field__message field__message--error">{pathMessage}</p> : null}
          </section>

          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Layout Templates</span>
                <h2>Session grid</h2>
              </div>
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

          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Presets</span>
                <h2>Saved workspace recipes</h2>
              </div>
            </div>

            <div className="preset-grid">
              {presets.map((preset) => (
                <article key={preset.id} className={`preset-card ${preset.id === draft.presetId ? 'is-active' : ''}`}>
                  <div>
                    <h3>{preset.name}</h3>
                    <p>{preset.description}</p>
                  </div>
                  <div className="preset-card__meta">
                    <span>{getLayoutTemplate(preset.layoutTemplateId).name}</span>
                    <span>{preset.paneDefinitions.length} panes</span>
                  </div>
                  <div className="preset-card__actions">
                    <button className="button button--ghost" onClick={() => applyPresetToDraft(preset.id)} type="button">
                      Use preset
                    </button>
                    <button className="button button--ghost" onClick={() => deletePreset(preset.id)} type="button">
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="preset-editor">
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
              <div className="preset-editor__actions">
                <button
                  className="button button--secondary"
                  onClick={() => {
                    const created = saveDraftAsPreset(presetName, presetDescription);
                    if (created) {
                      setPresetName('');
                      setPresetDescription('');
                    }
                  }}
                  type="button"
                >
                  <Save size={16} />
                  Save as preset
                </button>
                {selectedPreset ? (
                  <button
                    className="button button--ghost"
                    onClick={() => updatePresetFromDraft(selectedPreset.id, presetName || undefined, presetDescription || undefined)}
                    type="button"
                  >
                    Update selected preset
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Pane Definitions</span>
                <h2>Agent and shell assignments</h2>
              </div>
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
                      <span className="pane-editor__role-pill" style={{ borderColor: role.accent, color: role.accent }}>
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
                          <span>YOLO mode for {role.displayName}.</span>
                        </label>
                        <p className="muted-copy">Uses `{yoloStartupCommand}` as the startup command.</p>
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
                      <span>Auto-start this pane when the project space opens.</span>
                    </label>
                  </article>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="configurator__sidebar">
          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Summary</span>
                <h2>Launch plan</h2>
              </div>
            </div>

            <dl className="summary-list">
              <div>
                <dt>Project</dt>
                <dd>{draft.displayName || deriveDisplayNameFromPath(draft.rootPath || 'Workspace')}</dd>
              </div>
              <div>
                <dt>Root path</dt>
                <dd>{draft.rootPath || 'Not selected'}</dd>
              </div>
              <div>
                <dt>Layout</dt>
                <dd>{layout.name}</dd>
              </div>
              <div>
                <dt>Preset</dt>
                <dd>{selectedPreset?.name ?? 'Custom'}</dd>
              </div>
            </dl>

            <label className="toggle">
              <input
                checked={settings.restoreOpenProjectSpaces}
                onChange={(event) => updateSettings({ restoreOpenProjectSpaces: event.target.checked })}
                type="checkbox"
              />
              <span>Restore open project spaces on next app launch.</span>
            </label>

            <label className="toggle">
              <input
                checked={settings.rememberRecentProjectPaths}
                onChange={(event) => updateSettings({ rememberRecentProjectPaths: event.target.checked })}
                type="checkbox"
              />
              <span>Remember recent project root paths.</span>
            </label>

            <button className="button button--primary button--launch" disabled={submitting} onClick={handleLaunch} type="button">
              <Rocket size={18} />
              {draftMode === 'edit' ? 'Save Project Space' : 'Configure Agents'}
            </button>
          </section>

          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Spaces</span>
                <h2>Saved project spaces</h2>
              </div>
            </div>

            <div className="sidebar-stack">
              {sortedSpaces.map((space) => (
                <article key={space.id} className="sidebar-card">
                  <div>
                    <strong>{space.displayName}</strong>
                    <p>{space.rootPath}</p>
                  </div>
                  <div className="sidebar-card__actions">
                    {space.isOpen ? (
                      <button className="button button--ghost" onClick={() => activateSpace(space.id)} type="button">
                        Open tab
                      </button>
                    ) : (
                      <button className="button button--ghost" onClick={() => void reopenSpace(space.id)} type="button">
                        Reopen
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="glass-card section-card">
            <div className="section-card__header">
              <div>
                <span className="eyebrow">Recent Paths</span>
                <h2>Quick roots</h2>
              </div>
            </div>

            <div className="sidebar-stack">
              {settings.recentProjectPaths.length ? (
                settings.recentProjectPaths.map((entry) => (
                  <button
                    key={entry}
                    className="sidebar-card sidebar-card--button"
                    onClick={() =>
                      updateDraft({
                        rootPath: entry,
                        displayName: draft.displayName.trim() || deriveDisplayNameFromPath(entry),
                      })
                    }
                    type="button"
                  >
                    <span>{entry}</span>
                  </button>
                ))
              ) : (
                <p className="muted-copy">Recent project roots appear here after you launch project spaces.</p>
              )}
            </div>
          </section>
        </aside>
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
