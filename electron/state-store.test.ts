import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TabSpec, WindowSpec, WorkspaceTemplate } from '../src/shared/session';
import { readWorkspaces, sanitizeState, sanitizeWorkspace, StateStore, type StateChange } from './state-store';

let dir: string;
const stores: StateStore[] = [];

async function open(): Promise<StateStore> {
  const store = await StateStore.open(dir, { saveDelayMs: 30 });
  stores.push(store);
  return store;
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

function tab(id: string, paneIds: string[], extra: Partial<TabSpec> = {}): TabSpec {
  return {
    id,
    layout: paneIds.length === 1
      ? { type: 'pane', paneId: paneIds[0] }
      : { type: 'split', direction: 'row', children: paneIds.map((paneId) => ({ type: 'pane' as const, paneId })), sizes: paneIds.map(() => 1 / paneIds.length) },
    panes: Object.fromEntries(paneIds.map((paneId) => [paneId, { id: paneId, profileId: 'pwsh', cwd: 'C:\\' }])),
    focusedPaneId: paneIds[0],
    ...extra,
  };
}

function windowSpec(id: string, tabs: TabSpec[]): WindowSpec {
  return { id, kind: 'normal', tabs, activeTabId: tabs[0]?.id ?? null, bounds: { x: 10, y: 20, width: 1200, height: 800 } };
}

function workspace(id: string, name: string): WorkspaceTemplate {
  const base = tab('t', ['w1', 'w2']);
  return { id, name, rootPath: 'D:\\Work', layout: base.layout, panes: base.panes, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

const V1_FILE = {
  version: 1,
  updatedAt: '2026-08-31T20:54:37.000Z',
  state: {
    settings: { recentProjectPaths: ['D:\\Work\\one'], lastActiveSpaceId: 's2', terminalFontFace: 'MesloLGL Nerd Font Regular', terminalFontSize: 14, windowState: { width: 1600, height: 900, x: 0, y: 0 } },
    roles: [],
    presets: [],
    projectSpaces: [
      { id: 's1', displayName: 'One', rootPath: 'D:\\Work\\one', pinned: false, layoutTemplateId: '1', paneDefinitions: [{ id: 'p1', roleId: 'claude-code', title: 'Claude Code', startupCommand: 'claude --dangerously-skip-permissions' }], isOpen: true },
      { id: 's2', displayName: 'Two', rootPath: 'D:\\Work\\two', pinned: true, layoutTemplateId: '2', paneDefinitions: [{ id: 'p2', roleId: 'codex' }, { id: 'p3', roleId: 'powershell', startupCommand: null }], isOpen: true },
    ],
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lookout-state-'));
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('sanitizeState', () => {
  it('drops tabs without valid panes, windows without tabs, and repairs references', () => {
    const { state, warnings } = sanitizeState({
      windows: [
        {
          id: 'w1', kind: 'normal', activeTabId: 'missing', sidebarWidth: 5000, bounds: { x: 0, y: 0, width: 10, height: 10 },
          tabs: [
            tab('t1', ['a', 'b'], { focusedPaneId: 'zzz' }),
            { id: 't2', layout: { type: 'pane', paneId: 'x' }, panes: { x: { id: 'x' } }, focusedPaneId: 'x' },
            // Broken layout, usable panes: rebuilt as a grid.
            { id: 't3', layout: 'garbage', panes: { c: { id: 'c', profileId: 'cmd' }, d: { id: 'd', profileId: 'cmd' } }, focusedPaneId: 'd' },
            // Layout leaf without a pane spec is dropped from the layout.
            { id: 't4', layout: { type: 'split', direction: 'column', children: [{ type: 'pane', paneId: 'e' }, { type: 'pane', paneId: 'ghost' }], sizes: [1, 1] }, panes: { e: { id: 'e', profileId: 'pwsh' } }, focusedPaneId: 'ghost' },
          ],
        },
        { id: 'w2', kind: 'quake', tabs: [], activeTabId: null },
        'junk',
      ],
      workspaces: [workspace('ws', 'WS'), { id: 'bad', name: 'Bad', layout: null, panes: {} }],
      recentDirectories: ['D:\\A', 'd:\\a\\', 'D:\\B', 7],
      closedTabs: [tab('c1', ['q']), { id: 'c2' }],
      firstRunComplete: true,
    });

    expect(state.windows).toHaveLength(1);
    const [window] = state.windows;
    expect(window.tabs.map((entry) => entry.id)).toEqual(['t1', 't3', 't4']);
    expect(window.activeTabId).toBe('t1');
    expect(window.bounds).toBeUndefined();
    expect(window.sidebarWidth).toBe(800);
    expect(window.tabs[0].focusedPaneId).toBe('a');
    expect(window.tabs[1].layout).toEqual({ type: 'split', direction: 'row', children: [{ type: 'pane', paneId: 'c' }, { type: 'pane', paneId: 'd' }], sizes: [0.5, 0.5] });
    expect(window.tabs[1].focusedPaneId).toBe('d');
    expect(window.tabs[2].layout).toEqual({ type: 'pane', paneId: 'e' });
    expect(window.tabs[2].focusedPaneId).toBe('e');
    expect(state.workspaces.map((entry) => entry.id)).toEqual(['ws']);
    expect(state.recentDirectories).toEqual(['D:\\A', 'D:\\B']);
    expect(state.closedTabs.map((entry) => entry.id)).toEqual(['c1']);
    expect(state.firstRunComplete).toBe(true);
    expect(warnings.some((warning) => warning.includes('tab'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('workspace'))).toBe(true);
  });

  it('makes pane ids unique across tabs', () => {
    const { state } = sanitizeState({ windows: [windowSpec('w1', [tab('t1', ['a']), tab('t2', ['a', 'b'])])] });
    const ids = state.windows[0].tabs.flatMap((entry) => Object.keys(entry.panes));
    expect(new Set(ids).size).toBe(3);
    const second = state.windows[0].tabs[1];
    expect(Object.keys(second.panes)).toContain(second.focusedPaneId);
  });

  it('returns an empty state for garbage', () => {
    for (const input of [null, 'x', 1, []]) {
      expect(sanitizeState(input).state).toEqual({ version: 2, windows: [], workspaces: [], recentDirectories: [], closedTabs: [], firstRunComplete: false });
    }
  });
});

describe('StateStore', () => {
  it('starts empty, persists debounced changes and reloads them', async () => {
    const store = await open();
    expect(store.get().windows).toEqual([]);
    expect((await readdir(dir)).includes('state.json')).toBe(false);

    store.setWindow(windowSpec('w1', [tab('t1', ['a', 'b'])]));
    store.upsertWorkspace(workspace('ws1', 'Workspace'));
    store.addRecentDirectory('D:\\Work');
    await store.flush();
    const saved = await readState();
    expect((saved.windows as WindowSpec[])[0].id).toBe('w1');
    await store.dispose();

    const reopened = await open();
    expect(reopened.get().windows[0].tabs[0].panes.a.profileId).toBe('pwsh');
    expect(reopened.get().workspaces[0].name).toBe('Workspace');
    expect(reopened.get().recentDirectories).toEqual(['D:\\Work']);
  });

  it('debounces writes', async () => {
    const store = await open();
    for (let index = 0; index < 5; index += 1) store.addRecentDirectory(`D:\\dir${index}`);
    expect((await readdir(dir)).includes('state.json')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readState()).recentDirectories).toEqual(['D:\\dir4', 'D:\\dir3', 'D:\\dir2', 'D:\\dir1', 'D:\\dir0']);
  });

  it('manages windows, workspaces, recents and closed tabs and emits change kinds', async () => {
    const store = await open();
    const changes: StateChange[] = [];
    store.onChange((change) => changes.push(change));

    const snapshot = store.get();
    store.setWindow(windowSpec('w1', [tab('t1', ['a'])]));
    store.setWindow(windowSpec('w2', [tab('t2', ['b'])]));
    store.setWindow({ ...windowSpec('w1', [tab('t1', ['a']), tab('t3', ['c'])]), maximized: true });
    expect(snapshot.windows).toEqual([]);
    expect(store.get().windows.map((window) => [window.id, window.tabs.length])).toEqual([['w1', 2], ['w2', 1]]);
    // A pane id already used by another window is replaced.
    const clash = store.setWindow(windowSpec('w3', [tab('t4', ['b'])]))!;
    expect(Object.keys(clash.tabs[0].panes)[0]).not.toBe('b');
    store.removeWindow('w3');
    store.removeWindow('w2');
    expect(store.get().windows.map((window) => window.id)).toEqual(['w1']);

    const created = store.upsertWorkspace(workspace('ws1', 'First'))!;
    expect(created.createdAt).toBe('2026-01-01T00:00:00.000Z');
    const renamed = store.upsertWorkspace({ ...workspace('ws1', 'Renamed'), createdAt: '2030-01-01T00:00:00.000Z' })!;
    expect(renamed.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(renamed.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(store.get().workspaces).toHaveLength(1);
    expect(store.upsertWorkspace({ id: 'bad' } as WorkspaceTemplate)).toBeNull();
    expect(store.deleteWorkspace('nope')).toBe(false);
    expect(store.deleteWorkspace('ws1')).toBe(true);

    for (let index = 0; index < 25; index += 1) store.addRecentDirectory(`D:\\dir${index}`);
    store.addRecentDirectory('d:\\DIR3\\');
    store.addRecentDirectory('   ');
    const recents = store.get().recentDirectories;
    expect(recents).toHaveLength(20);
    expect(recents[0]).toBe('d:\\DIR3\\');
    expect(recents.filter((entry) => entry.toLowerCase().startsWith('d:\\dir3'))).toHaveLength(1);

    for (let index = 0; index < 12; index += 1) store.pushClosedTab(tab(`closed${index}`, [`cp${index}`]));
    expect(store.get().closedTabs).toHaveLength(10);
    expect(store.popClosedTab()?.id).toBe('closed11');
    expect(store.popClosedTab()?.id).toBe('closed10');
    expect(store.get().closedTabs).toHaveLength(8);

    store.setFirstRunComplete();
    store.setFirstRunComplete();
    const kinds = new Set(changes.map((change) => change.kind));
    expect([...kinds].sort()).toEqual(['closedTabs', 'firstRunComplete', 'recentDirectories', 'windows', 'workspaces']);
    expect(changes.filter((change) => change.kind === 'firstRunComplete')).toHaveLength(1);
    expect(changes.at(-1)!.state).toBe(store.get());
    await store.flush();
    expect((await readState()).firstRunComplete).toBe(true);
  });

  it('restores from state.json.bak when state.json is corrupt', async () => {
    const store = await open();
    store.addRecentDirectory('D:\\first');
    await store.flush();
    store.addRecentDirectory('D:\\second');
    await store.flush();
    await store.dispose();
    await writeFile(join(dir, 'state.json'), '{"windows": [');

    const recovered = await open();
    expect(recovered.get().recentDirectories).toEqual(['D:\\first']);
    expect(recovered.getLoadWarnings().some((warning) => warning.includes('restored'))).toBe(true);
    expect((await readdir(dir)).some((file) => file.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('migrates v1 when state.json is missing, then archives lookout-state.json', async () => {
    await writeFile(join(dir, 'lookout-state.json'), JSON.stringify(V1_FILE));
    const store = await open();
    const state = store.get();
    expect(state.workspaces.map((entry) => entry.name)).toEqual(['One', 'Two']);
    // Spaces become one-click workspaces; they are not reopened as (agent) tabs on first launch.
    expect(state.windows).toEqual([]);
    expect(state.recentDirectories).toEqual(['D:\\Work\\one']);
    expect(state.firstRunComplete).toBe(false);

    const files = await readdir(dir);
    expect(files).toContain('state.json');
    expect(files).toContain('lookout-state.v1-migrated.json');
    expect(files).not.toContain('lookout-state.json');
    expect((await readState()).workspaces).toHaveLength(2);

    const migration = store.getV1Migration()!;
    expect(migration.font).toMatchObject({ face: 'MesloLGL Nerd Font Regular', size: 14 });
    store.setFirstRunComplete();
    expect(store.getV1Migration()).toBeNull();
  });

  it('offers the archived v1 data again while first-run is incomplete', async () => {
    await writeFile(join(dir, 'lookout-state.json'), JSON.stringify(V1_FILE));
    const first = await open();
    await first.dispose();

    const second = await open();
    expect(second.getV1Migration()?.font.size).toBe(14);
    // State is not migrated twice.
    expect(second.get().workspaces).toHaveLength(2);
    second.setFirstRunComplete();
    await second.dispose();

    const third = await open();
    expect(third.getV1Migration()).toBeNull();
  });

  it('leaves a non-v1 lookout-state.json alone', async () => {
    await writeFile(join(dir, 'lookout-state.json'), JSON.stringify({ version: 7 }));
    const store = await open();
    expect(store.get().workspaces).toEqual([]);
    expect(store.getV1Migration()).toBeNull();
    expect(await readdir(dir)).toContain('lookout-state.json');
    expect(store.getLoadWarnings().some((warning) => warning.includes('not a Lookout v1'))).toBe(true);
  });

  it('saves, reads and prunes buffers', async () => {
    const store = await open();
    await store.saveBuffers([{ paneId: 'p1', data: '\u001b[31mred\u001b[0m' }, { paneId: 'p2', data: 'two' }]);
    expect(await store.readBuffer('p1')).toBe('\u001b[31mred\u001b[0m');
    expect((await readdir(store.buffersDir)).sort()).toEqual(['p1.vt', 'p2.vt']);

    await store.saveBuffers([{ paneId: 'p2', data: 'two v2' }, { paneId: '../evil', data: 'x' }]);
    expect((await readdir(store.buffersDir)).sort()).toEqual(['p2.vt']);
    expect(await store.readBuffer('p2')).toBe('two v2');
    expect(await store.readBuffer('p1')).toBeNull();
    expect(await store.readBuffer('../evil')).toBeNull();

    await store.deleteBuffer('p2');
    await store.deleteBuffer('p2');
    expect(await readdir(store.buffersDir)).toEqual([]);
  });
});

describe('administrator workspaces', () => {
  it('keeps only a real elevate flag', () => {
    expect(sanitizeWorkspace({ ...workspace('a', 'A'), elevate: true })?.elevate).toBe(true);
    expect(sanitizeWorkspace({ ...workspace('b', 'B'), elevate: 'yes' })).not.toHaveProperty('elevate');
    expect(sanitizeWorkspace(workspace('c', 'C'))).not.toHaveProperty('elevate');
  });

  it("reads another instance's workspaces, or none", async () => {
    expect(await readWorkspaces(dir)).toEqual([]);
    const store = await open();
    store.upsertWorkspace({ ...workspace('a', 'Infra'), elevate: true });
    store.upsertWorkspace(workspace('b', 'Notes'));
    await store.flush();
    expect((await readWorkspaces(dir)).map((entry) => [entry.name, entry.elevate ?? false])).toEqual([
      ['Infra', true],
      ['Notes', false],
    ]);
  });

  it('imports newer copies only and keeps their timestamps', async () => {
    const store = await open();
    const original = { ...workspace('a', 'Infra'), elevate: true, updatedAt: '2026-02-01T00:00:00.000Z' };
    expect(store.importWorkspaces([original])).toBe(true);
    expect(store.get().workspaces).toMatchObject([{ id: 'a', name: 'Infra', elevate: true, updatedAt: original.updatedAt }]);
    expect(store.importWorkspaces([original])).toBe(false);

    // Edited in this instance since: the older copy from the other one does not overwrite it.
    const local = store.upsertWorkspace({ ...original, name: 'Infra (edited here)' })!;
    expect(store.importWorkspaces([original])).toBe(false);
    expect(store.get().workspaces[0].name).toBe('Infra (edited here)');

    // Edited in the other instance after that: its copy wins.
    const later = { ...original, name: 'Infra v2', updatedAt: new Date(Date.parse(local.updatedAt) + 1000).toISOString() };
    expect(store.importWorkspaces([later, workspace('b', 'Notes')])).toBe(true);
    expect(store.get().workspaces.map((entry) => entry.name)).toEqual(['Infra v2', 'Notes']);
  });
});
