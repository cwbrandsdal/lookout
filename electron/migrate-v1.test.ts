import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { LayoutNode } from '../src/shared/session';
import { convertV1Layout, migrateV1 } from './migrate-v1';

const YOLO_CLAUDE = 'claude --dangerously-skip-permissions';
const YOLO_CODEX = 'codex --dangerously-bypass-approvals-and-sandbox';

function pane(id: string, roleId: string, extra: Record<string, unknown> = {}) {
  const titles: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', powershell: 'PowerShell', build: 'Build', test: 'Test' };
  return { id, title: titles[roleId] ?? roleId, roleId, shellType: 'powershell', arguments: [], envVars: {}, autoStart: true, needsSetup: false, ...extra };
}

function space(id: string, displayName: string, extra: Record<string, unknown>) {
  return {
    id, displayName, rootPath: `D:\\Work\\${displayName.toLowerCase()}`, pinned: false, layoutTemplateId: '2', paneDefinitions: [],
    layoutTree: null, createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-04-01T10:00:00.000Z', presetId: null, isOpen: true, ...extra,
  };
}

/** A v1 file shaped like the real one (envelope, roles, presets, spaces with/without layout trees). */
const V1_FIXTURE = {
  version: 1,
  updatedAt: '2026-08-31T20:54:37.000Z',
  state: {
    settings: {
      restoreOpenProjectSpaces: true,
      rememberRecentProjectPaths: true,
      showPinnedTabsOnly: true,
      recentProjectPaths: ['D:\\Work\\alpha', 'd:\\work\\ALPHA\\', 'D:\\Work\\beta', '', 42],
      lastActiveSpaceId: 'space-delta',
      terminalFontFace: 'MesloLGL Nerd Font Propo',
      terminalFontSize: 14,
      terminalLineHeight: 1,
      terminalLetterSpacing: 0,
      theme: 'dark',
      windowState: { width: 1680, height: 1077, x: -7, y: -7, isMaximized: true },
    },
    roles: [
      { id: 'claude-code', displayName: 'Claude Code', description: '', executableCommand: 'claude', argsTemplate: [], defaultStartupCommand: 'claude', envVars: {}, accent: '#ff9166' },
      { id: 'codex', displayName: 'Codex', description: '', executableCommand: 'codex', argsTemplate: [], defaultStartupCommand: 'codex', envVars: { CODEX_HOME: 'C:\\codex' }, accent: '#5a9dff' },
      { id: 'powershell', displayName: 'PowerShell', description: '', argsTemplate: [], envVars: {}, accent: '#67d3b0' },
      { id: 'build', displayName: 'Build', description: '', argsTemplate: [], defaultStartupCommand: '', envVars: {}, accent: '#f9be57' },
    ],
    presets: [{ id: 'preset-1' }, { id: 'preset-2' }],
    projectSpaces: [
      space('space-beta', 'Beta', {
        layoutTemplateId: '4',
        paneDefinitions: [
          pane('b1', 'powershell', { executable: 'C:\\Program Files\\Git\\bin\\bash.exe', arguments: ['--login'], workingDirectory: 'E:\\elsewhere' }),
          pane('b2', 'codex', { envVars: { EXTRA: '1' } }),
          pane('b3', 'claude-code', { startupCommand: `${YOLO_CLAUDE} ` }),
        ],
        // [b1 | [b2 / b3]]
        layoutTree: {
          type: 'split', direction: 'horizontal', children: [
            { type: 'leaf', paneId: 'b1' },
            { type: 'split', direction: 'vertical', children: [{ type: 'leaf', paneId: 'b2' }, { type: 'leaf', paneId: 'b3' }] },
          ],
        },
      }),
      space('space-alpha', 'Alpha', {
        pinned: true,
        layoutTemplateId: '4',
        paneDefinitions: [
          pane('a1', 'claude-code', { startupCommand: YOLO_CLAUDE }),
          pane('a2', 'codex'),
          pane('a3', 'powershell'),
          pane('a4', 'build', { title: 'Server', startupCommand: '', workingDirectory: 'web' }),
          pane('a5', 'test'),
        ],
      }),
      space('space-gamma', 'Gamma', {
        pinned: true,
        isOpen: false,
        layoutTemplateId: '6',
        paneDefinitions: [pane('g1', 'codex', { startupCommand: YOLO_CODEX }), pane('g1', 'codex'), pane('g3', 'claude-code'), pane('g4', 'claude-code'), pane('g5', 'build'), pane('g6', 'test')],
      }),
      space('space-delta', 'Delta', {
        pinned: true,
        layoutTemplateId: '1',
        rootPath: 'X:\\',
        paneDefinitions: [pane('d1', 'claude-code', { title: 'Claude Code' })],
        layoutTree: { type: 'leaf', paneId: 'd1' },
      }),
      space('space-broken', 'Broken', {
        layoutTemplateId: '2',
        paneDefinitions: [pane('x1', 'powershell'), pane('x2', 'powershell')],
        layoutTree: { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', paneId: 'nope' }, { type: 'leaf', paneId: 'gone' }] },
      }),
      'not a space',
    ],
  },
};

function ids() {
  let counter = 0;
  return () => `id-${++counter}`;
}

function shape(node: LayoutNode): unknown {
  return node.type === 'pane' ? node.paneId : { [node.direction]: node.children.map(shape) };
}

describe('migrateV1', () => {
  const result = migrateV1(V1_FIXTURE, { newId: ids(), now: () => '2026-11-03T00:00:00.000Z' })!;

  it('rejects non-v1 input', () => {
    for (const input of [null, undefined, 'x', 42, [], {}, { version: 2, state: { settings: {} } }, { version: 1, state: 'x' }]) {
      expect(migrateV1(input)).toBeNull();
    }
    // A bare (un-enveloped) state is accepted, like the v1 sanitizer did.
    expect(migrateV1({ settings: {}, projectSpaces: [] })).not.toBeNull();
  });

  it('maps every project space to a workspace with the v1 id, name and root', () => {
    expect(result.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.rootPath])).toEqual([
      ['space-beta', 'Beta', 'D:\\Work\\beta'],
      ['space-alpha', 'Alpha', 'D:\\Work\\alpha'],
      ['space-gamma', 'Gamma', 'D:\\Work\\gamma'],
      ['space-delta', 'Delta', 'X:\\'],
      ['space-broken', 'Broken', 'D:\\Work\\broken'],
    ]);
    expect(result.workspaces[0]).toMatchObject({ createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-04-01T10:00:00.000Z' });
    expect(result.warnings.some((warning) => warning.includes('#6'))).toBe(true);
    expect(result.stats).toMatchObject({ spaces: 5, openSpaces: 4, pinnedOpenSpaces: 2, presetsSkipped: 2 });
  });

  it('converts and flattens v1 layout trees (horizontal = row, vertical = column)', () => {
    const beta = result.workspaces[0];
    expect(shape(beta.layout)).toEqual({ row: ['b1', { column: ['b2', 'b3'] }] });
    expect(beta.layout.type === 'split' && beta.layout.sizes).toEqual([0.5, 0.5]);
    expect(shape(result.workspaces[3].layout)).toBe('d1');
  });

  it('builds a grid from the template when there is no usable tree', () => {
    // Template "4" = 2 columns; the fifth pane is not shown by v1 and is dropped.
    expect(shape(result.workspaces[1].layout)).toEqual({ column: [{ row: ['a1', 'a2'] }, { row: ['a3', 'a4'] }] });
    expect(Object.keys(result.workspaces[1].panes)).toEqual(['a1', 'a2', 'a3', 'a4']);
    // Template "6" = 3 columns; the duplicate pane id was replaced.
    const gamma = result.workspaces[2];
    expect(shape(gamma.layout)).toMatchObject({ column: [{ row: ['g1', expect.any(String), 'g3'] }, { row: ['g4', 'g5', 'g6'] }] });
    expect(Object.keys(gamma.panes)).toHaveLength(6);
    // A tree with unknown panes falls back to the template grid.
    expect(shape(result.workspaces[4].layout)).toEqual({ row: ['x1', 'x2'] });
    expect(result.warnings.some((warning) => warning.includes('"Broken"'))).toBe(true);
  });

  it('uses the template column counts', () => {
    const counts: Array<[string, number, number]> = [['1', 1, 1], ['2', 2, 1], ['8', 4, 2], ['10', 5, 2], ['12', 4, 3], ['14', 7, 2], ['16', 4, 4]];
    for (const [templateId, columns, rows] of counts) {
      const panes = Array.from({ length: Number(templateId) }, (_, index) => pane(`p${index}`, 'powershell'));
      const migrated = migrateV1({ version: 1, state: { settings: {}, projectSpaces: [space('s', 'S', { layoutTemplateId: templateId, paneDefinitions: panes })] } })!;
      const layout = migrated.workspaces[0].layout;
      if (rows === 1) {
        expect(layout.type === 'pane' ? 1 : layout.children.length).toBe(columns);
      } else {
        expect(layout.type === 'split' && layout.direction).toBe('column');
        expect(layout.type === 'split' && layout.children.length).toBe(rows);
        const first = layout.type === 'split' ? layout.children[0] : layout;
        expect(first.type === 'split' && first.children.length).toBe(columns);
      }
    }
  });

  it('maps panes: profile, cwd, startup command, custom titles, env', () => {
    const alpha = result.workspaces[1].panes;
    expect(alpha.a1).toEqual({ id: 'a1', profileId: 'pwsh', cwd: 'D:\\Work\\alpha', startupCommand: YOLO_CLAUDE });
    expect(alpha.a2).toEqual({ id: 'a2', profileId: 'pwsh', cwd: 'D:\\Work\\alpha', startupCommand: 'codex', env: { CODEX_HOME: 'C:\\codex' } });
    expect(alpha.a3).toEqual({ id: 'a3', profileId: 'pwsh', cwd: 'D:\\Work\\alpha' });
    // Explicitly cleared startup command, custom title, relative working directory.
    expect(alpha.a4).toEqual({ id: 'a4', profileId: 'pwsh', cwd: 'D:\\Work\\alpha\\web', title: 'Server' });

    const beta = result.workspaces[0].panes;
    expect(beta.b1).toMatchObject({ profileId: 'v1-bash', cwd: 'E:\\elsewhere' });
    expect(beta.b1.startupCommand).toBeUndefined();
    expect(beta.b2.env).toEqual({ CODEX_HOME: 'C:\\codex', EXTRA: '1' });
    expect(beta.b3.startupCommand).toBe(YOLO_CLAUDE);
    expect(result.workspaces[2].panes.g1.startupCommand).toBe(YOLO_CODEX);
    expect(result.workspaces[3].panes.d1).toEqual({ id: 'd1', profileId: 'pwsh', cwd: 'X:\\', startupCommand: 'claude' });

    expect(result.profiles).toEqual([
      { id: 'v1-bash', name: 'bash', commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" --login', source: 'migrated' },
    ]);
    expect(result.referencedProfileIds.sort()).toEqual(['pwsh', 'v1-bash']);
    expect(result.stats.customTitles).toBe(1);
  });

  it('restores open spaces as tabs of one window: pinned first, last active selected', () => {
    const window = result.window!;
    expect(window.kind).toBe('normal');
    expect(window.tabs.map((tab) => [tab.title, tab.workspaceId])).toEqual([
      ['Alpha', 'space-alpha'],
      ['Delta', 'space-delta'],
      ['Beta', 'space-beta'],
      ['Broken', 'space-broken'],
    ]);
    expect(window.activeTabId).toBe(window.tabs[1].id);
    expect(window.bounds).toEqual({ x: -7, y: -7, width: 1680, height: 1077 });
    expect(window.maximized).toBe(true);

    // Live tabs get fresh pane ids so they never collide with the template or each other.
    const alphaTab = window.tabs[0];
    const paneIds = Object.keys(alphaTab.panes);
    expect(paneIds).toHaveLength(4);
    expect(paneIds.some((id) => id.startsWith('a'))).toBe(false);
    expect(alphaTab.focusedPaneId).toBe(paneIds[0]);
    expect(Object.values(alphaTab.panes).map((entry) => entry.startupCommand)).toEqual([YOLO_CLAUDE, 'codex', undefined, undefined]);
    const allIds = window.tabs.flatMap((tab) => Object.keys(tab.panes));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('maps font, recents and restore preference', () => {
    expect(result.font).toEqual({ face: 'MesloLGL Nerd Font Propo', size: 14, lineHeight: 1, letterSpacing: 0 });
    expect(result.recentDirectories).toEqual(['D:\\Work\\alpha', 'D:\\Work\\beta']);
    expect(result.restoreSession).toBe(true);
  });

  it('yields no window when nothing was open', () => {
    const migrated = migrateV1({ version: 1, state: { settings: { restoreOpenProjectSpaces: false }, projectSpaces: [space('s', 'S', { isOpen: false })] } })!;
    expect(migrated.window).toBeNull();
    expect(migrated.restoreSession).toBe(false);
    // A space without panes still gets one shell pane.
    expect(Object.values(migrated.workspaces[0].panes)).toEqual([expect.objectContaining({ profileId: 'pwsh', cwd: 'D:\\Work\\s' })]);
  });
});

describe('convertV1Layout', () => {
  it('keeps explicit sizes and collapses same-direction nesting', () => {
    const tree = {
      type: 'split', direction: 'horizontal', sizes: [30, 70], children: [
        { type: 'leaf', paneId: 'a' },
        { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', paneId: 'b' }, { type: 'leaf', paneId: 'c' }] },
      ],
    };
    const layout = convertV1Layout(tree, new Set(['a', 'b', 'c']))!;
    expect(shape(layout)).toEqual({ row: ['a', 'b', 'c'] });
    expect(layout.type === 'split' && layout.sizes.map((size) => Math.round(size * 100))).toEqual([30, 35, 35]);
    expect(convertV1Layout({ type: 'leaf', paneId: 'z' }, new Set(['a']))).toBeNull();
  });
});

// Opt-in: LOOKOUT_V1_SAMPLE=<copy of %APPDATA%\Lookout\lookout-state.json> npx vitest run electron/migrate-v1.test.ts
describe.skipIf(!process.env.LOOKOUT_V1_SAMPLE)('real v1 state', () => {
  it('migrates without losing spaces or panes', async () => {
    const raw = JSON.parse(await readFile(process.env.LOOKOUT_V1_SAMPLE!, 'utf8'));
    const migrated = migrateV1(raw)!;
    expect(migrated).not.toBeNull();
    expect(migrated.workspaces).toHaveLength(raw.state.projectSpaces.length);
    const summary = {
      ...migrated.stats,
      workspaces: migrated.workspaces.length,
      tabs: migrated.window?.tabs.length ?? 0,
      activeTab: migrated.window?.tabs.find((tab) => tab.id === migrated.window?.activeTabId)?.title,
      tabOrder: migrated.window?.tabs.map((tab) => tab.title).join(', '),
      recentDirectories: migrated.recentDirectories.length,
      extraProfiles: migrated.profiles.length,
      font: migrated.font,
      bounds: migrated.window?.bounds,
      maximized: migrated.window?.maximized,
      warnings: migrated.warnings,
      relativeCwds: migrated.workspaces.flatMap((workspace) => Object.values(workspace.panes).map((entry) => entry.cwd)).filter((cwd) => cwd && !/^[a-z]:\\/i.test(cwd)),
    };
    console.log(JSON.stringify(summary, null, 2));
    expect(summary.relativeCwds).toEqual([]);
  });
});
