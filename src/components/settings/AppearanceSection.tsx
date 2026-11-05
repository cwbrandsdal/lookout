import { Upload } from 'lucide-react';
import { useMemo, useRef } from 'react';

import { findScheme } from '../../shared/color-schemes';
import { DEFAULT_COLOR_SCHEME, SETTINGS_LIMITS } from '../../shared/settings-defaults';
import type { ColorScheme, FontSettings, LookoutSettings } from '../../shared/settings';
import { DARK_THEME_INFO, isLookoutDarkScheme, type DarkTheme } from '../../shared/themes';
import { getState, pushToast, useApp } from '../../state/store';
import { allSchemes, resolveAppTheme, resolveScheme } from '../../terminal/theme';
import { Group, NumberField, Row, Segmented, SelectField, Switch } from './controls';
import { DarkThemePicker } from './DarkThemePicker';
import { useRowVisible } from './filter';
import { FontPicker } from './FontPicker';
import { fontAdvice, useInstalledFonts } from './fonts';
import { importSchemesFromFile, mergeSchemes } from './helpers';
import { updateSettings } from './save';
import { SchemePicker } from './SchemePicker';
import { TerminalPreview } from './TerminalPreview';

function save(mutate: (draft: LookoutSettings) => void): void {
  void updateSettings(mutate);
}

const FONT_WEIGHT_OPTIONS: ReadonlyArray<{ value: FontSettings['weight']; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'bold', label: 'Bold' },
  { value: '100', label: '100 · Thin' },
  { value: '200', label: '200 · Extra light' },
  { value: '300', label: '300 · Light' },
  { value: '400', label: '400 · Regular' },
  { value: '500', label: '500 · Medium' },
  { value: '600', label: '600 · Semibold' },
  { value: '700', label: '700 · Bold' },
  { value: '800', label: '800 · Extra bold' },
  { value: '900', label: '900 · Black' },
];

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

async function importSchemeFiles(files: readonly File[]): Promise<void> {
  const imported: ColorScheme[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      imported.push(...importSchemesFromFile(file.name, await readFileText(file)));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (imported.length && (await updateSettings((draft) => { draft.schemes = mergeSchemes(draft.schemes, imported); }))) {
    const [first] = imported;
    pushToast({
      tone: 'success',
      title: imported.length === 1 ? `Imported “${first.name}”` : `Imported ${imported.length} color schemes`,
      body: imported.length > 1 ? imported.map((scheme) => scheme.name).join(', ') : undefined,
      action: imported.length === 1 ? { label: 'Use it', run: () => save((draft) => { draft.colorScheme = first.name; }) } : undefined,
    });
  }
  if (errors.length) {
    pushToast({ tone: 'error', title: 'Could not import color scheme', body: errors.join('\n') });
  }
}

/** Switches the dark window theme; terminals on a Lookout dark scheme follow along, other schemes stay. */
function selectDarkTheme(theme: DarkTheme): void {
  save((draft) => {
    draft.darkTheme = theme;
    if (isLookoutDarkScheme(draft.colorScheme)) draft.colorScheme = DARK_THEME_INFO[theme].scheme;
    if (draft.appTheme === 'light') draft.appTheme = 'dark';
  });
}

function deleteScheme(name: string): void {
  const key = name.toLowerCase();
  const { settings } = getState();
  const removed = settings.schemes.find((scheme) => scheme.name.toLowerCase() === key);
  if (!removed) return;
  const wasCurrent = settings.colorScheme.toLowerCase() === key;

  void updateSettings((draft) => {
    draft.schemes = draft.schemes.filter((scheme) => scheme.name.toLowerCase() !== key);
    if (!findScheme(draft.colorScheme, draft.schemes)) draft.colorScheme = DEFAULT_COLOR_SCHEME;
  }).then((saved) => {
    if (!saved) return;
    pushToast({
      tone: 'info',
      title: `Deleted “${removed.name}”`,
      action: {
        label: 'Undo',
        run: () =>
          save((draft) => {
            draft.schemes = mergeSchemes(draft.schemes, [removed]);
            if (wasCurrent) draft.colorScheme = removed.name;
          }),
      },
    });
  });
}

export function AppearanceSection() {
  const settings = useApp((state) => state.settings);
  const fonts = useInstalledFonts();
  const fileInput = useRef<HTMLInputElement>(null);
  const { font, terminal } = settings;

  const schemes = useMemo(() => allSchemes(settings), [settings]);
  const userSchemes = useMemo(() => new Set(settings.schemes.map((scheme) => scheme.name.toLowerCase())), [settings.schemes]);
  const scheme = resolveScheme(settings, undefined, resolveAppTheme(settings));
  const advice = fontAdvice(font.face, fonts);
  const suggestion = advice?.suggestion;

  const previewVisible = [
    useRowVisible('appearance.preview'),
    useRowVisible('appearance.fontFace'),
    useRowVisible('appearance.colorScheme'),
    useRowVisible('appearance.cursorStyle'),
  ].some(Boolean);

  return (
    <>
      <Group section="appearance">
        <Row id="appearance.appTheme">
          {(id) => (
            <Segmented
              id={id}
              value={settings.appTheme}
              options={[
                { value: 'system', label: 'System' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(value) => save((draft) => { draft.appTheme = value; })}
            />
          )}
        </Row>
        <Row id="appearance.darkTheme" stacked disabled={settings.appTheme === 'light'}>
          {(id) => <DarkThemePicker id={id} value={settings.darkTheme} onChange={selectDarkTheme} />}
        </Row>
      </Group>

      {previewVisible ? (
        <div className="settings-group">
          <TerminalPreview scheme={scheme} font={font} cursorStyle={terminal.cursorStyle} cursorBlink={terminal.cursorBlink} />
        </div>
      ) : null}

      <Group section="appearance" title="Font">
        <Row
          id="appearance.fontFace"
          note={
            advice ? (
              <div className="settings-note settings-note--warn">
                {advice.message}
                {suggestion ? (
                  <button type="button" className="settings-link" onClick={() => save((draft) => { draft.font.face = suggestion; })}>
                    Use {suggestion}
                  </button>
                ) : null}
              </div>
            ) : null
          }
        >
          {(id) => (
            <FontPicker
              id={id}
              fonts={fonts}
              value={font.face}
              placeholder="Cascadia Mono"
              onCommit={(face) => updateSettings((draft) => { draft.font.face = face; })}
            />
          )}
        </Row>
        <Row id="appearance.fontSize">
          {(id) => (
            <NumberField
              id={id}
              suffix="px"
              step={0.5}
              value={font.size}
              min={SETTINGS_LIMITS.fontSize.min}
              max={SETTINGS_LIMITS.fontSize.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.font.size = value; })}
            />
          )}
        </Row>
        <Row id="appearance.lineHeight">
          {(id) => (
            <NumberField
              id={id}
              step={0.05}
              value={font.lineHeight}
              min={SETTINGS_LIMITS.lineHeight.min}
              max={SETTINGS_LIMITS.lineHeight.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.font.lineHeight = value; })}
            />
          )}
        </Row>
        <Row id="appearance.letterSpacing">
          {(id) => (
            <NumberField
              id={id}
              suffix="px"
              step={0.5}
              value={font.letterSpacing}
              min={SETTINGS_LIMITS.letterSpacing.min}
              max={SETTINGS_LIMITS.letterSpacing.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.font.letterSpacing = value; })}
            />
          )}
        </Row>
        <Row id="appearance.fontWeight">
          {(id) => (
            <SelectField id={id} width={160} value={font.weight} options={FONT_WEIGHT_OPTIONS} onChange={(value) => save((draft) => { draft.font.weight = value; })} />
          )}
        </Row>
        <Row id="appearance.fontWeightBold">
          {(id) => (
            <SelectField
              id={id}
              width={160}
              value={font.weightBold}
              options={FONT_WEIGHT_OPTIONS}
              onChange={(value) => save((draft) => { draft.font.weightBold = value; })}
            />
          )}
        </Row>
      </Group>

      <Group section="appearance" title="Cursor">
        <Row id="appearance.cursorStyle">
          {(id) => (
            <Segmented
              id={id}
              value={terminal.cursorStyle}
              options={[
                { value: 'bar', label: 'Bar' },
                { value: 'block', label: 'Block' },
                { value: 'underline', label: 'Underline' },
              ]}
              onChange={(value) => save((draft) => { draft.terminal.cursorStyle = value; })}
            />
          )}
        </Row>
        <Row id="appearance.cursorBlink">
          {(id) => <Switch id={id} checked={terminal.cursorBlink} onChange={(value) => save((draft) => { draft.terminal.cursorBlink = value; })} />}
        </Row>
      </Group>

      <Group
        section="appearance"
        title="Color scheme"
        description="Used by every profile without its own scheme. Import .itermcolors files or Windows Terminal scheme JSON."
        bare
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".itermcolors,.json,application/json"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length) void importSchemeFiles(files);
              }}
            />
            <button type="button" className="btn btn--sm" title="Import a .itermcolors file or Windows Terminal scheme JSON" onClick={() => fileInput.current?.click()}>
              <Upload size={13} />
              Import…
            </button>
          </>
        }
      >
        <SchemePicker
          schemes={schemes}
          selected={scheme.name}
          userSchemes={userSchemes}
          onSelect={(name) => save((draft) => { draft.colorScheme = name; })}
          onDelete={deleteScheme}
        />
      </Group>

      <Group section="appearance" title="Rendering">
        <Row id="appearance.minimumContrastRatio">
          {(id) => (
            <NumberField
              id={id}
              step={0.5}
              value={terminal.minimumContrastRatio}
              min={SETTINGS_LIMITS.minimumContrastRatio.min}
              max={SETTINGS_LIMITS.minimumContrastRatio.max}
              onCommit={(value) => value !== undefined && updateSettings((draft) => { draft.terminal.minimumContrastRatio = value; })}
            />
          )}
        </Row>
        <Row id="appearance.gpu">
          {(id) => (
            <Switch
              id={id}
              checked={terminal.gpuAcceleration === 'auto'}
              onChange={(value) => save((draft) => { draft.terminal.gpuAcceleration = value ? 'auto' : 'off'; })}
            />
          )}
        </Row>
        <Row id="appearance.unicodeVersion">
          {(id) => (
            <Segmented
              id={id}
              value={terminal.unicodeVersion}
              options={[
                { value: '11', label: 'Unicode 11' },
                { value: 'graphemes', label: 'Graphemes' },
              ]}
              onChange={(value) => save((draft) => { draft.terminal.unicodeVersion = value; })}
            />
          )}
        </Row>
      </Group>
    </>
  );
}
