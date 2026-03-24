import { create } from 'zustand';

import {
  buildLayoutTreeFromTemplate,
  LAYOUT_TEMPLATES,
  coercePaneDefinitions,
  createBlankDraft,
  createDefaultAppState,
  createPaneDefinition,
  createProjectSpaceFromDraft,
  createPreset,
  deriveDisplayNameFromPath,
  getNextTemplateForPaneCount,
  getRoleDefinition,
  makeDraftFromPreset,
  makeDraftFromSpace,
  removePaneFromLayoutTree,
  splitLayoutTreeAtPane,
  swapPaneIdsInLayoutTree,
  wrapPaneAtLayoutEdge,
  type AppSettings,
  type LayoutNode,
  type LayoutEdge,
  type LayoutSplitDirection,
  type LayoutTemplateId,
  type PaneDefinition,
  type PersistedAppState,
  type Preset,
  type ProjectSpace,
  type ProjectSpaceDraft,
  type RoleDefinition,
  type TerminalEvent,
  type TerminalLaunchResponse,
  type TerminalSessionRuntime,
} from '../types/app';
import { clearTerminalStream, pushTerminalData } from '../services/terminal-stream';

interface DraftPanePatch extends Partial<PaneDefinition> {
  roleId?: string;
}

interface AppStoreState {
  hydrated: boolean;
  bootWarnings: string[];
  view: 'configurator' | 'workspace' | 'settings';
  draftMode: 'create' | 'edit';
  activeSpaceId: string | null;
  settings: AppSettings;
  roles: RoleDefinition[];
  presets: Preset[];
  projectSpaces: ProjectSpace[];
  draft: ProjectSpaceDraft;
  sessionStateByPaneId: Record<string, TerminalSessionRuntime>;
  initialize: (state: PersistedAppState, warnings?: string[]) => void;
  setView: (view: 'configurator' | 'workspace' | 'settings') => void;
  activateSpace: (spaceId: string) => void;
  openCreateConfigurator: (seedPath?: string) => void;
  openEditConfigurator: (spaceId: string) => void;
  updateDraft: (patch: Partial<ProjectSpaceDraft>) => void;
  setDraftLayout: (layoutId: LayoutTemplateId) => void;
  updateDraftPane: (paneId: string, patch: DraftPanePatch) => void;
  applyPresetToDraft: (presetId: string) => void;
  saveDraftAsPreset: (name: string, description: string) => Preset | null;
  updatePresetFromDraft: (presetId: string, name?: string, description?: string) => void;
  deletePreset: (presetId: string) => void;
  saveDraftToProjectSpace: () => Promise<void>;
  addPaneToSpace: (spaceId: string, roleId?: string) => Promise<void>;
  reorderPanes: (spaceId: string, sourcePaneId: string, targetPaneId: string) => void;
  splitPane: (spaceId: string, paneId: string, direction: LayoutSplitDirection) => Promise<void>;
  removePane: (spaceId: string, paneId: string) => Promise<void>;
  movePaneToEdge: (spaceId: string, paneId: string, edge: LayoutEdge) => void;
  reopenSpace: (spaceId: string) => Promise<void>;
  closeSpace: (spaceId: string) => Promise<void>;
  renameSpace: (spaceId: string, displayName: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  clearWarning: (warning: string) => void;
  handleTerminalEvent: (event: TerminalEvent) => void;
  launchPane: (
    spaceId: string,
    paneId: string,
    options?: { clearBuffer?: boolean; cols?: number; rows?: number },
  ) => Promise<TerminalLaunchResponse | null>;
  restartPane: (spaceId: string, paneId: string) => Promise<void>;
  stopPane: (paneId: string) => Promise<void>;
  clearPaneBuffer: (paneId: string) => void;
  restoreOpenSpaces: () => Promise<void>;
}

const defaultState = createDefaultAppState();

export const useAppStore = create<AppStoreState>((set, get) => ({
  hydrated: false,
  bootWarnings: [],
  view: 'configurator',
  draftMode: 'create',
  activeSpaceId: null,
  settings: defaultState.settings,
  roles: defaultState.roles,
  presets: defaultState.presets,
  projectSpaces: defaultState.projectSpaces,
  draft: createBlankDraft(),
  sessionStateByPaneId: {},
  initialize: (state, warnings = []) => {
    const openSpaces = state.settings.restoreOpenProjectSpaces ? state.projectSpaces.filter((space) => space.isOpen) : [];
    const lastActive =
      openSpaces.find((space) => space.id === state.settings.lastActiveSpaceId)?.id ?? openSpaces[0]?.id ?? null;

    set({
      hydrated: true,
      bootWarnings: warnings,
      view: openSpaces.length ? 'workspace' : 'configurator',
      draftMode: 'create',
      activeSpaceId: lastActive,
      settings: {
        ...state.settings,
      },
      roles: state.roles,
      presets: state.presets,
      projectSpaces: state.projectSpaces.map((space) =>
        state.settings.restoreOpenProjectSpaces ? space : { ...space, isOpen: false },
      ),
      draft: createBlankDraft(),
      sessionStateByPaneId: {},
    });
  },
  setView: (view) => set({ view }),
  activateSpace: (spaceId) => {
    set((state) => ({
      activeSpaceId: spaceId,
      view: 'workspace',
      settings: {
        ...state.settings,
        lastActiveSpaceId: spaceId,
      },
    }));
  },
  openCreateConfigurator: (seedPath) =>
    set({
      view: 'configurator',
      draftMode: 'create',
      draft: {
        ...createBlankDraft(),
        rootPath: seedPath ?? '',
        displayName: seedPath ? deriveDisplayNameFromPath(seedPath) : '',
      },
    }),
  openEditConfigurator: (spaceId) => {
    const space = get().projectSpaces.find((entry) => entry.id === spaceId);
    if (!space) {
      return;
    }

    set({
      view: 'configurator',
      draftMode: 'edit',
      draft: makeDraftFromSpace(space),
    });
  },
  updateDraft: (patch) =>
    set((state) => ({
      draft: {
        ...state.draft,
        ...patch,
      },
    })),
  setDraftLayout: (layoutId) =>
    set((state) => ({
      draft: {
        ...state.draft,
        layoutTemplateId: layoutId,
        paneDefinitions: coercePaneDefinitions(layoutId, state.draft.paneDefinitions),
        layoutTree: null,
      },
    })),
  updateDraftPane: (paneId, patch) =>
    set((state) => {
      const roles = state.roles;
      return {
        draft: {
          ...state.draft,
          paneDefinitions: state.draft.paneDefinitions.map((pane) => {
            if (pane.id !== paneId) {
              return pane;
            }

            const role = getRoleDefinition(patch.roleId ?? pane.roleId, roles);
            return {
              ...pane,
              ...patch,
              title:
                typeof patch.title === 'string'
                  ? patch.title
                  : patch.roleId && pane.title === getRoleDefinition(pane.roleId, roles).displayName
                    ? role.displayName
                    : pane.title,
              startupCommand:
                patch.startupCommand !== undefined
                  ? patch.startupCommand
                  : patch.roleId && pane.startupCommand === getRoleDefinition(pane.roleId, roles).defaultStartupCommand
                    ? role.defaultStartupCommand
                    : pane.startupCommand,
            };
          }),
        },
      };
    }),
  applyPresetToDraft: (presetId) => {
    const preset = get().presets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }

    set((state) => ({
      draft: {
        ...makeDraftFromPreset(preset),
        rootPath: state.draft.rootPath,
        displayName: state.draft.displayName,
      },
    }));
  },
  saveDraftAsPreset: (name, description) => {
    const state = get();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return null;
    }

    const preset = createPreset(trimmedName, description.trim(), state.draft.layoutTemplateId, state.draft.paneDefinitions);
    set({
      presets: [preset, ...state.presets],
      draft: {
        ...state.draft,
        presetId: preset.id,
      },
    });
    return preset;
  },
  updatePresetFromDraft: (presetId, name, description) =>
    set((state) => ({
      presets: state.presets.map((preset) =>
        preset.id === presetId
          ? {
              ...preset,
              name: name?.trim() ? name.trim() : preset.name,
              description: description !== undefined ? description.trim() : preset.description,
              layoutTemplateId: state.draft.layoutTemplateId,
              paneDefinitions: (state.draft.layoutTree
                ? state.draft.paneDefinitions
                : coercePaneDefinitions(state.draft.layoutTemplateId, state.draft.paneDefinitions)
              ).map((pane) => ({
                ...pane,
                id: crypto.randomUUID(),
              })),
              layoutTree: state.draft.layoutTree ?? null,
              updatedAt: new Date().toISOString(),
            }
          : preset,
      ),
    })),
  deletePreset: (presetId) =>
    set((state) => ({
      presets: state.presets.filter((preset) => preset.id !== presetId),
      projectSpaces: state.projectSpaces.map((space) =>
        space.presetId === presetId
          ? {
              ...space,
              presetId: null,
              updatedAt: new Date().toISOString(),
            }
          : space,
      ),
      draft: {
        ...state.draft,
        presetId: state.draft.presetId === presetId ? null : state.draft.presetId,
      },
    })),
  saveDraftToProjectSpace: async () => {
    const state = get();
    const draft = {
      ...state.draft,
      displayName: state.draft.displayName.trim() || deriveDisplayNameFromPath(state.draft.rootPath),
      rootPath: state.draft.rootPath.trim(),
      paneDefinitions: state.draft.layoutTree
        ? state.draft.paneDefinitions
        : coercePaneDefinitions(state.draft.layoutTemplateId, state.draft.paneDefinitions),
    };

    const existingByPath = state.projectSpaces.find(
      (space) => space.rootPath.toLowerCase() === draft.rootPath.toLowerCase() && space.id !== draft.projectSpaceId,
    );

    let targetSpace = state.draftMode === 'edit'
      ? state.projectSpaces.find((space) => space.id === draft.projectSpaceId) ?? null
      : null;

    if (!targetSpace && existingByPath) {
      targetSpace = existingByPath;
    }

    const now = new Date().toISOString();
    const nextSpace = targetSpace
      ? {
          ...targetSpace,
          displayName: draft.displayName,
          rootPath: draft.rootPath,
          layoutTemplateId: draft.layoutTemplateId,
          paneDefinitions: draft.paneDefinitions,
          layoutTree: draft.layoutTree ?? null,
          updatedAt: now,
          presetId: draft.presetId ?? null,
          isOpen: true,
        }
      : createProjectSpaceFromDraft(draft);

    const previousPaneIds = targetSpace?.paneDefinitions.map((pane) => pane.id) ?? [];
    const currentPaneIds = nextSpace.paneDefinitions.map((pane) => pane.id);
    const removedPaneIds = previousPaneIds.filter((paneId) => !currentPaneIds.includes(paneId));

    await Promise.all(
      [...new Set([...previousPaneIds, ...removedPaneIds])]
        .map((paneId) => get().sessionStateByPaneId[paneId]?.sessionId)
        .filter((value): value is string => Boolean(value))
        .map((sessionId) => window.lookout.stopTerminalSession(sessionId)),
    );

    set((current) => {
      const projectSpaces = targetSpace
        ? current.projectSpaces.map((space) => (space.id === nextSpace.id ? nextSpace : space))
        : [nextSpace, ...current.projectSpaces];
      const recentProjectPaths = current.settings.rememberRecentProjectPaths
        ? addRecentProjectPath(current.settings.recentProjectPaths, nextSpace.rootPath)
        : current.settings.recentProjectPaths;

      const sessionStateByPaneId = { ...current.sessionStateByPaneId };
      previousPaneIds.forEach((paneId) => {
        sessionStateByPaneId[paneId] = {
          status: 'idle',
          buffer: '',
        };
      });

      return {
        projectSpaces,
        activeSpaceId: nextSpace.id,
        view: 'workspace',
        draftMode: 'create',
        draft: createBlankDraft(),
        settings: {
          ...current.settings,
          lastActiveSpaceId: nextSpace.id,
          recentProjectPaths,
        },
        sessionStateByPaneId,
      };
    });

  },
  addPaneToSpace: async (spaceId, roleId) => {
    const state = get();
    const space = state.projectSpaces.find((entry) => entry.id === spaceId);
    if (!space) {
      return;
    }

    if (space.layoutTree) {
      const anchorPane = space.paneDefinitions.at(-1);
      if (!anchorPane) {
        return;
      }

      const nextPane = createPaneDefinition(space.paneDefinitions.length, roleId);
      const splitDirection = getSuggestedSplitDirection(space.layoutTree);
      const updatedSpace: ProjectSpace = {
        ...space,
        layoutTemplateId: getNextTemplateForPaneCount(space.paneDefinitions.length + 1),
        paneDefinitions: [...space.paneDefinitions, nextPane],
        layoutTree: splitLayoutTreeAtPane(space.layoutTree, anchorPane.id, splitDirection, nextPane.id),
        updatedAt: new Date().toISOString(),
      };

      set((current) => ({
        projectSpaces: current.projectSpaces.map((entry) => (entry.id === spaceId ? updatedSpace : entry)),
      }));

      return;
    }

    const nextTemplate = LAYOUT_TEMPLATES.find((template) => template.count > space.paneDefinitions.length);
    if (!nextTemplate) {
      return;
    }

    const nextPaneDefinitions = [...space.paneDefinitions];
    while (nextPaneDefinitions.length < nextTemplate.count) {
      nextPaneDefinitions.push(createPaneDefinition(nextPaneDefinitions.length, roleId));
    }

    const updatedSpace: ProjectSpace = {
      ...space,
      layoutTemplateId: nextTemplate.id,
      paneDefinitions: nextPaneDefinitions,
      layoutTree: space.layoutTree ?? null,
      updatedAt: new Date().toISOString(),
    };

    set((current) => ({
      projectSpaces: current.projectSpaces.map((entry) => (entry.id === spaceId ? updatedSpace : entry)),
    }));

  },
  reorderPanes: (spaceId, sourcePaneId, targetPaneId) =>
    set((state) => {
      const space = state.projectSpaces.find((entry) => entry.id === spaceId);
      if (!space || sourcePaneId === targetPaneId) {
        return state;
      }

      const sourceIndex = space.paneDefinitions.findIndex((pane) => pane.id === sourcePaneId);
      const targetIndex = space.paneDefinitions.findIndex((pane) => pane.id === targetPaneId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return state;
      }

      if (space.layoutTree) {
        return {
          projectSpaces: state.projectSpaces.map((entry) =>
            entry.id === spaceId
              ? {
                  ...entry,
                  layoutTree: swapPaneIdsInLayoutTree(space.layoutTree!, sourcePaneId, targetPaneId),
                  updatedAt: new Date().toISOString(),
                }
              : entry,
          ),
        };
      }

      const reorderedPanes = [...space.paneDefinitions];
      const [movedPane] = reorderedPanes.splice(sourceIndex, 1);
      reorderedPanes.splice(targetIndex, 0, movedPane);

      return {
        projectSpaces: state.projectSpaces.map((entry) =>
          entry.id === spaceId
            ? {
                ...entry,
                paneDefinitions: reorderedPanes,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      };
    }),
  splitPane: async (spaceId, paneId, direction) => {
    const state = get();
    const space = state.projectSpaces.find((entry) => entry.id === spaceId);
    const sourcePane = space?.paneDefinitions.find((entry) => entry.id === paneId);
    if (!space || !sourcePane) {
      return;
    }

    const nextPane = createPaneDefinition(space.paneDefinitions.length, sourcePane.roleId);
    const baseLayoutTree = space.layoutTree ?? buildLayoutTreeFromTemplate(space.layoutTemplateId, space.paneDefinitions.map((pane) => pane.id));
    if (!baseLayoutTree) {
      return;
    }

    const updatedSpace: ProjectSpace = {
      ...space,
      layoutTemplateId: getNextTemplateForPaneCount(space.paneDefinitions.length + 1),
      paneDefinitions: [...space.paneDefinitions, nextPane],
      layoutTree: splitLayoutTreeAtPane(baseLayoutTree, paneId, direction, nextPane.id),
      updatedAt: new Date().toISOString(),
    };

    set((current) => ({
      projectSpaces: current.projectSpaces.map((entry) => (entry.id === spaceId ? updatedSpace : entry)),
    }));
  },
  removePane: async (spaceId, paneId) => {
    const state = get();
    const space = state.projectSpaces.find((entry) => entry.id === spaceId);
    if (!space || space.paneDefinitions.length <= 1) {
      return;
    }

    const runtime = state.sessionStateByPaneId[paneId];
    if (runtime?.sessionId) {
      await window.lookout.stopTerminalSession(runtime.sessionId);
    }

    const nextPaneDefinitions = space.paneDefinitions.filter((pane) => pane.id !== paneId);
    const baseLayoutTree =
      space.layoutTree ?? buildLayoutTreeFromTemplate(space.layoutTemplateId, space.paneDefinitions.map((pane) => pane.id));
    const nextLayoutTree = baseLayoutTree ? removePaneFromLayoutTree(baseLayoutTree, paneId) : null;
    const nextTemplateId = getNextTemplateForPaneCount(nextPaneDefinitions.length);

    set((current) => {
      const sessionStateByPaneId = { ...current.sessionStateByPaneId };
      delete sessionStateByPaneId[paneId];

      return {
        projectSpaces: current.projectSpaces.map((entry) =>
          entry.id === spaceId
            ? {
                ...entry,
                layoutTemplateId: nextTemplateId,
                paneDefinitions: nextPaneDefinitions,
                layoutTree: nextLayoutTree,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
        sessionStateByPaneId,
      };
    });
  },
  movePaneToEdge: (spaceId, paneId, edge) =>
    set((state) => {
      const space = state.projectSpaces.find((entry) => entry.id === spaceId);
      if (!space || space.paneDefinitions.length <= 1) {
        return state;
      }

      const baseLayoutTree =
        space.layoutTree ?? buildLayoutTreeFromTemplate(space.layoutTemplateId, space.paneDefinitions.map((pane) => pane.id));
      if (!baseLayoutTree) {
        return state;
      }

      const nextLayoutTree = wrapPaneAtLayoutEdge(baseLayoutTree, paneId, edge);
      if (nextLayoutTree === baseLayoutTree) {
        return state;
      }

      return {
        projectSpaces: state.projectSpaces.map((entry) =>
          entry.id === spaceId
            ? {
                ...entry,
                layoutTree: nextLayoutTree,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      };
    }),
  reopenSpace: async (spaceId) => {
    const state = get();
    const target = state.projectSpaces.find((space) => space.id === spaceId);
    if (!target) {
      return;
    }

    const reopened = {
      ...target,
      isOpen: true,
      updatedAt: new Date().toISOString(),
    };

    set((current) => ({
      projectSpaces: current.projectSpaces.map((space) => (space.id === spaceId ? reopened : space)),
      activeSpaceId: spaceId,
      view: 'workspace',
      settings: {
        ...current.settings,
        lastActiveSpaceId: spaceId,
        recentProjectPaths: current.settings.rememberRecentProjectPaths
          ? addRecentProjectPath(current.settings.recentProjectPaths, target.rootPath)
          : current.settings.recentProjectPaths,
      },
    }));

  },
  closeSpace: async (spaceId) => {
    const state = get();
    const target = state.projectSpaces.find((space) => space.id === spaceId);
    if (!target) {
      return;
    }

    await Promise.all(
      target.paneDefinitions
        .map((pane) => state.sessionStateByPaneId[pane.id]?.sessionId)
        .filter((value): value is string => Boolean(value))
        .map((sessionId) => window.lookout.stopTerminalSession(sessionId)),
    );

    const openSpaces = state.projectSpaces.filter((space) => space.isOpen && space.id !== spaceId);
    const nextActiveSpaceId = state.activeSpaceId === spaceId ? openSpaces[0]?.id ?? null : state.activeSpaceId;

    set((current) => ({
      projectSpaces: current.projectSpaces.map((space) =>
        space.id === spaceId
          ? {
              ...space,
              isOpen: false,
              updatedAt: new Date().toISOString(),
            }
          : space,
      ),
      activeSpaceId: nextActiveSpaceId,
      view: nextActiveSpaceId ? 'workspace' : 'configurator',
      settings: {
        ...current.settings,
        lastActiveSpaceId: nextActiveSpaceId,
      },
    }));
  },
  renameSpace: (spaceId, displayName) =>
    set((state) => ({
      projectSpaces: state.projectSpaces.map((space) =>
        space.id === spaceId
          ? {
              ...space,
              displayName: displayName.trim() || space.displayName,
              updatedAt: new Date().toISOString(),
            }
          : space,
      ),
    })),
  updateSettings: (patch) =>
    set((state) => ({
      settings: {
        ...state.settings,
        ...patch,
      },
    })),
  clearWarning: (warning) =>
    set((state) => ({
      bootWarnings: state.bootWarnings.filter((entry) => entry !== warning),
    })),
  handleTerminalEvent: (event) =>
    set((state) => {
      const runtime = state.sessionStateByPaneId[event.paneId] ?? {
        status: 'idle',
        buffer: '',
      };

      if (event.type === 'data') {
        pushTerminalData(event.paneId, event.data);

        if (runtime.sessionId === event.sessionId && runtime.status === 'running') {
          return state;
        }

        return {
          sessionStateByPaneId: {
            ...state.sessionStateByPaneId,
            [event.paneId]: {
              ...runtime,
              sessionId: event.sessionId,
              status: runtime.status === 'error' ? 'error' : 'running',
            },
          },
        };
      }

      if (runtime.sessionId && runtime.sessionId !== event.sessionId) {
        return state;
      }

      return {
        sessionStateByPaneId: {
          ...state.sessionStateByPaneId,
          [event.paneId]: {
            ...runtime,
            status: runtime.status === 'error' ? 'error' : 'exited',
            exitCode: event.exitCode,
            lastEndedAt: new Date().toISOString(),
            sessionId: undefined,
          },
        },
      };
    }),
  launchPane: async (spaceId, paneId, options) => {
    const state = get();
    const space = state.projectSpaces.find((entry) => entry.id === spaceId);
    const pane = space?.paneDefinitions.find((entry) => entry.id === paneId);
    if (!space || !pane) {
      return null;
    }

    const runtime = state.sessionStateByPaneId[paneId];
    if (runtime?.status === 'starting' || runtime?.status === 'running') {
      return null;
    }

    const role = getRoleDefinition(pane.roleId, state.roles);
    const mergedEnv = {
      ...role.envVars,
      ...pane.envVars,
    };
    const response = await startPaneSession(space, pane, role, mergedEnv, options?.clearBuffer ?? true, options?.cols, options?.rows);
    return response;
  },
  restartPane: async (spaceId, paneId) => {
    const sessionId = get().sessionStateByPaneId[paneId]?.sessionId;
    if (sessionId) {
      await window.lookout.stopTerminalSession(sessionId);
    }

    await get().launchPane(spaceId, paneId, { clearBuffer: true });
  },
  stopPane: async (paneId) => {
    const sessionId = get().sessionStateByPaneId[paneId]?.sessionId;
    if (!sessionId) {
      return;
    }

    await window.lookout.stopTerminalSession(sessionId);
    set((state) => ({
      sessionStateByPaneId: {
        ...state.sessionStateByPaneId,
        [paneId]: {
          ...state.sessionStateByPaneId[paneId],
          sessionId: undefined,
          status: 'exited',
          lastEndedAt: new Date().toISOString(),
        },
      },
    }));
  },
  clearPaneBuffer: (paneId) =>
    set((state) => {
      clearTerminalStream(paneId);
      return {
        sessionStateByPaneId: {
          ...state.sessionStateByPaneId,
          [paneId]: {
            ...(state.sessionStateByPaneId[paneId] ?? { status: 'idle' }),
            buffer: '',
          },
        },
      };
    }),
  restoreOpenSpaces: async () => {
    return;
  },
}));

async function startPaneSession(
  space: ProjectSpace,
  pane: PaneDefinition,
  role: RoleDefinition,
  envVars: Record<string, string>,
  clearBuffer: boolean,
  cols?: number,
  rows?: number,
): Promise<TerminalLaunchResponse> {
  if (clearBuffer) {
    clearTerminalStream(pane.id);
  }

  useAppStore.setState((state) => ({
    sessionStateByPaneId: {
      ...state.sessionStateByPaneId,
      [pane.id]: {
        ...state.sessionStateByPaneId[pane.id],
        buffer: clearBuffer ? '' : state.sessionStateByPaneId[pane.id]?.buffer ?? '',
        error: undefined,
        exitCode: undefined,
        status: 'starting',
        lastStartedAt: new Date().toISOString(),
      },
    },
  }));

  const response = await window.lookout.startTerminalSession({
    paneId: pane.id,
    projectSpaceId: space.id,
    rootPath: space.rootPath,
    workingDirectory: pane.workingDirectory,
    executable: pane.executable,
    args: pane.arguments.length ? pane.arguments : role.argsTemplate,
    startupCommand: pane.startupCommand?.trim() || role.defaultStartupCommand,
    envVars,
    cols,
    rows,
  });

  if (!response.ok) {
    pushTerminalData(pane.id, `\r\n[lookout] ${response.error}\r\n`);
    useAppStore.setState((state) => ({
      sessionStateByPaneId: {
        ...state.sessionStateByPaneId,
        [pane.id]: {
          ...state.sessionStateByPaneId[pane.id],
          status: 'error',
          error: response.error,
          sessionId: undefined,
          lastEndedAt: new Date().toISOString(),
        },
      },
    }));
    return response;
  }

  useAppStore.setState((state) => ({
    sessionStateByPaneId: {
      ...state.sessionStateByPaneId,
      [pane.id]: {
        ...state.sessionStateByPaneId[pane.id],
        sessionId: response.sessionId,
        cwd: response.cwd,
        shellPath: response.shellPath,
        status: 'running',
        error: undefined,
      },
    },
  }));

  return response;
}

function addRecentProjectPath(paths: string[], nextPath: string): string[] {
  return [nextPath, ...paths.filter((entry) => entry.toLowerCase() !== nextPath.toLowerCase())].slice(0, 8);
}

function getSuggestedSplitDirection(layoutTree: LayoutNode): LayoutSplitDirection {
  if (layoutTree.type === 'leaf') {
    return 'horizontal';
  }

  return layoutTree.direction === 'horizontal' ? 'vertical' : 'horizontal';
}
