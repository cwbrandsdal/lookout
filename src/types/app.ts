export const LAYOUT_TEMPLATE_IDS = ['1', '2', '4', '6', '8', '10', '12', '14', '16'] as const;

export type LayoutTemplateId = (typeof LAYOUT_TEMPLATE_IDS)[number];
export type ShellType = 'powershell';
export type ThemePreference = 'dark';
export type RuntimeStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';
export type LayoutSplitDirection = 'horizontal' | 'vertical';
export type LayoutEdge = 'left' | 'right' | 'top' | 'bottom';

export interface LayoutLeafNode {
  type: 'leaf';
  paneId: string;
}

export interface LayoutSplitNode {
  type: 'split';
  direction: LayoutSplitDirection;
  children: [LayoutNode, LayoutNode];
  sizes?: [number, number];
}

export type LayoutNode = LayoutLeafNode | LayoutSplitNode;

export interface LayoutTemplate {
  id: LayoutTemplateId;
  name: string;
  count: number;
  columns: number;
  rows: number;
  description: string;
}

export interface RoleDefinition {
  id: string;
  displayName: string;
  description: string;
  executableCommand?: string;
  argsTemplate: string[];
  defaultStartupCommand?: string;
  envVars: Record<string, string>;
  accent: string;
}

export interface PaneDefinition {
  id: string;
  title: string;
  roleId: string;
  shellType: ShellType;
  executable?: string;
  arguments: string[];
  workingDirectory?: string;
  startupCommand?: string;
  envVars: Record<string, string>;
  autoStart: boolean;
}

export interface ProjectSpace {
  id: string;
  displayName: string;
  rootPath: string;
  layoutTemplateId: LayoutTemplateId;
  paneDefinitions: PaneDefinition[];
  layoutTree?: LayoutNode | null;
  createdAt: string;
  updatedAt: string;
  presetId?: string | null;
  isOpen: boolean;
}

export interface ProjectSpaceDraft {
  projectSpaceId?: string | null;
  displayName: string;
  rootPath: string;
  layoutTemplateId: LayoutTemplateId;
  paneDefinitions: PaneDefinition[];
  layoutTree?: LayoutNode | null;
  presetId?: string | null;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  layoutTemplateId: LayoutTemplateId;
  paneDefinitions: PaneDefinition[];
  layoutTree?: LayoutNode | null;
  createdAt: string;
  updatedAt: string;
}

export interface WindowStateSnapshot {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface AppSettings {
  restoreOpenProjectSpaces: boolean;
  rememberRecentProjectPaths: boolean;
  recentProjectPaths: string[];
  lastActiveSpaceId?: string | null;
  terminalFontFace: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalLetterSpacing: number;
  theme: ThemePreference;
  windowState: WindowStateSnapshot;
}

export interface PersistedAppState {
  settings: AppSettings;
  roles: RoleDefinition[];
  presets: Preset[];
  projectSpaces: ProjectSpace[];
}

export interface PersistedStateEnvelope {
  version: number;
  updatedAt: string;
  state: PersistedAppState;
}

export interface TerminalLaunchRequest {
  paneId: string;
  projectSpaceId: string;
  rootPath: string;
  workingDirectory?: string;
  executable?: string;
  args: string[];
  startupCommand?: string;
  envVars: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalLaunchSuccess {
  ok: true;
  sessionId: string;
  cwd: string;
  shellPath: string;
}

export interface TerminalLaunchFailure {
  ok: false;
  error: string;
}

export type TerminalLaunchResponse = TerminalLaunchSuccess | TerminalLaunchFailure;

export interface ValidationResponse {
  valid: boolean;
  normalizedPath?: string;
  error?: string;
}

export interface TerminalSessionRuntime {
  sessionId?: string;
  status: RuntimeStatus;
  buffer: string;
  cwd?: string;
  shellPath?: string;
  error?: string;
  exitCode?: number | null;
  lastStartedAt?: string;
  lastEndedAt?: string;
}

export interface TerminalDataEvent {
  type: 'data';
  sessionId: string;
  paneId: string;
  projectSpaceId: string;
  data: string;
}

export interface TerminalExitEvent {
  type: 'exit';
  sessionId: string;
  paneId: string;
  projectSpaceId: string;
  exitCode: number;
  signal?: number;
}

export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

export const DEFAULT_WINDOW_STATE: WindowStateSnapshot = {
  width: 1600,
  height: 980,
};

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { id: '1', name: 'Single', count: 1, columns: 1, rows: 1, description: 'One terminal focused on a single task.' },
  { id: '2', name: '2 Sessions', count: 2, columns: 2, rows: 1, description: 'Parallel agent or shell split.' },
  { id: '4', name: '4 Sessions', count: 4, columns: 2, rows: 2, description: 'Balanced 2x2 workspace.' },
  { id: '6', name: '6 Sessions', count: 6, columns: 3, rows: 2, description: 'Broad review layout.' },
  { id: '8', name: '8 Sessions', count: 8, columns: 4, rows: 2, description: 'High-density execution grid.' },
  { id: '10', name: '10 Sessions', count: 10, columns: 5, rows: 2, description: 'Wide coordination workspace.' },
  { id: '12', name: '12 Sessions', count: 12, columns: 4, rows: 3, description: 'Three-row review wall.' },
  { id: '14', name: '14 Sessions', count: 14, columns: 7, rows: 2, description: 'Maximum breadth with low height.' },
  { id: '16', name: '16 Sessions', count: 16, columns: 4, rows: 4, description: 'Full matrix for large projects.' },
];

export const DEFAULT_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Launches the Claude CLI inside PowerShell.',
    executableCommand: 'claude',
    argsTemplate: [],
    defaultStartupCommand: 'claude',
    envVars: {},
    accent: '#ff9166',
  },
  {
    id: 'codex',
    displayName: 'Codex',
    description: 'Launches the Codex CLI inside PowerShell.',
    executableCommand: 'codex',
    argsTemplate: [],
    defaultStartupCommand: 'codex',
    envVars: {},
    accent: '#5a9dff',
  },
  {
    id: 'powershell',
    displayName: 'PowerShell',
    description: 'Standard interactive PowerShell session.',
    argsTemplate: [],
    envVars: {},
    accent: '#67d3b0',
  },
  {
    id: 'build',
    displayName: 'Build',
    description: 'General build lane.',
    argsTemplate: [],
    defaultStartupCommand: '',
    envVars: {},
    accent: '#f9be57',
  },
  {
    id: 'git',
    displayName: 'Git',
    description: 'Repository inspection and branch operations.',
    argsTemplate: [],
    envVars: {},
    accent: '#ea6f91',
  },
  {
    id: 'test',
    displayName: 'Test',
    description: 'Testing lane.',
    argsTemplate: [],
    envVars: {},
    accent: '#79c0ff',
  },
  {
    id: 'logs',
    displayName: 'Logs',
    description: 'Logs or watch output.',
    argsTemplate: [],
    envVars: {},
    accent: '#8d91ff',
  },
  {
    id: 'notes',
    displayName: 'Notes',
    description: 'Scratchpad shell.',
    argsTemplate: [],
    envVars: {},
    accent: '#62d291',
  },
];

const DEFAULT_ROLE_SEQUENCE = [
  'claude-code',
  'claude-code',
  'codex',
  'codex',
  'build',
  'git',
  'test',
  'powershell',
  'logs',
  'notes',
  'powershell',
  'build',
  'git',
  'test',
  'logs',
  'notes',
];

export function getLayoutTemplate(layoutId: LayoutTemplateId): LayoutTemplate {
  return LAYOUT_TEMPLATES.find((template) => template.id === layoutId) ?? LAYOUT_TEMPLATES[0];
}

export function getRoleDefinition(roleId: string, roles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS): RoleDefinition {
  return roles.find((role) => role.id === roleId) ?? DEFAULT_ROLE_DEFINITIONS[0];
}

export function createPaneDefinition(index: number, roleId?: string): PaneDefinition {
  const resolvedRoleId = roleId ?? DEFAULT_ROLE_SEQUENCE[index % DEFAULT_ROLE_SEQUENCE.length];
  const role = getRoleDefinition(resolvedRoleId);

  return {
    id: crypto.randomUUID(),
    title: role.displayName,
    roleId: role.id,
    shellType: 'powershell',
    arguments: [],
    startupCommand: role.defaultStartupCommand,
    envVars: {},
    autoStart: true,
  };
}

export function coercePaneDefinitions(layoutId: LayoutTemplateId, panes: PaneDefinition[]): PaneDefinition[] {
  const expectedCount = getLayoutTemplate(layoutId).count;
  const normalized = panes.slice(0, expectedCount).map((pane) => normalizePaneDefinition(pane));

  while (normalized.length < expectedCount) {
    normalized.push(createPaneDefinition(normalized.length));
  }

  return normalized;
}

export function createBlankDraft(): ProjectSpaceDraft {
  return {
    projectSpaceId: null,
    displayName: '',
    rootPath: '',
    layoutTemplateId: '4',
    paneDefinitions: coercePaneDefinitions('4', []),
    layoutTree: null,
    presetId: null,
  };
}

export function createPreset(
  name: string,
  description: string,
  layoutTemplateId: LayoutTemplateId,
  paneDefinitions: PaneDefinition[],
): Preset {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    name,
    description,
    layoutTemplateId,
    paneDefinitions: coercePaneDefinitions(layoutTemplateId, paneDefinitions).map((pane) => ({
      ...pane,
      id: crypto.randomUUID(),
    })),
    layoutTree: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultPresets(): Preset[] {
  return [
    createPreset(
      'AI Pairing 4-pane',
      'Two Claude lanes and two Codex lanes for paired agent work.',
      '4',
      [
        createPaneDefinition(0, 'claude-code'),
        createPaneDefinition(1, 'claude-code'),
        createPaneDefinition(2, 'codex'),
        createPaneDefinition(3, 'codex'),
      ],
    ),
    createPreset(
      'Build/Test/Git/Notes',
      'Core repo operations in a 2x2 layout.',
      '4',
      [
        createPaneDefinition(0, 'build'),
        createPaneDefinition(1, 'test'),
        createPaneDefinition(2, 'git'),
        createPaneDefinition(3, 'notes'),
      ],
    ),
    createPreset(
      '8-pane review layout',
      'Wide terminal wall for review, logs, and automation.',
      '8',
      [
        createPaneDefinition(0, 'claude-code'),
        createPaneDefinition(1, 'codex'),
        createPaneDefinition(2, 'build'),
        createPaneDefinition(3, 'test'),
        createPaneDefinition(4, 'git'),
        createPaneDefinition(5, 'logs'),
        createPaneDefinition(6, 'powershell'),
        createPaneDefinition(7, 'notes'),
      ],
    ),
  ];
}

export function createDefaultAppState(): PersistedAppState {
  return {
    settings: {
      restoreOpenProjectSpaces: true,
      rememberRecentProjectPaths: true,
      recentProjectPaths: [],
      lastActiveSpaceId: null,
      terminalFontFace: 'MesloLGL Nerd Font Propo',
      terminalFontSize: 13,
      terminalLineHeight: 1,
      terminalLetterSpacing: 0,
      theme: 'dark',
      windowState: DEFAULT_WINDOW_STATE,
    },
    roles: [...DEFAULT_ROLE_DEFINITIONS],
    presets: createDefaultPresets(),
    projectSpaces: [],
  };
}

export function deriveDisplayNameFromPath(rootPath: string): string {
  const segments = rootPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? 'Workspace';
}

export function createProjectSpaceFromDraft(draft: ProjectSpaceDraft): ProjectSpace {
  const now = new Date().toISOString();
  const displayName = draft.displayName.trim() || deriveDisplayNameFromPath(draft.rootPath);

  return {
    id: draft.projectSpaceId ?? crypto.randomUUID(),
    displayName,
    rootPath: draft.rootPath.trim(),
    layoutTemplateId: draft.layoutTemplateId,
    paneDefinitions: draft.layoutTree
      ? draft.paneDefinitions.map((pane) => normalizePaneDefinition(pane))
      : coercePaneDefinitions(draft.layoutTemplateId, draft.paneDefinitions),
    layoutTree: draft.layoutTree ?? null,
    createdAt: now,
    updatedAt: now,
    presetId: draft.presetId ?? null,
    isOpen: true,
  };
}

export function makeDraftFromSpace(space: ProjectSpace): ProjectSpaceDraft {
  return {
    projectSpaceId: space.id,
    displayName: space.displayName,
    rootPath: space.rootPath,
    layoutTemplateId: space.layoutTemplateId,
    paneDefinitions: (space.layoutTree ? space.paneDefinitions : coercePaneDefinitions(space.layoutTemplateId, space.paneDefinitions)).map((pane) => ({
      ...pane,
      envVars: { ...pane.envVars },
      arguments: [...pane.arguments],
    })),
    layoutTree: space.layoutTree ?? null,
    presetId: space.presetId ?? null,
  };
}

export function makeDraftFromPreset(preset: Preset): ProjectSpaceDraft {
  const sourcePanes = preset.layoutTree ? preset.paneDefinitions : coercePaneDefinitions(preset.layoutTemplateId, preset.paneDefinitions);
  const paneIdMap = new Map<string, string>();
  const paneDefinitions = sourcePanes.map((pane) => {
    const nextId = crypto.randomUUID();
    paneIdMap.set(pane.id, nextId);
    return {
      ...pane,
      id: nextId,
      envVars: { ...pane.envVars },
      arguments: [...pane.arguments],
    };
  });

  return {
    projectSpaceId: null,
    displayName: '',
    rootPath: '',
    layoutTemplateId: preset.layoutTemplateId,
    paneDefinitions,
    layoutTree: preset.layoutTree ? remapLayoutTreePaneIds(preset.layoutTree, paneIdMap) : null,
    presetId: preset.id,
  };
}

export function normalizePaneDefinition(input: Partial<PaneDefinition>): PaneDefinition {
  const roleId = typeof input.roleId === 'string' ? input.roleId : DEFAULT_ROLE_DEFINITIONS[0].id;
  const role = getRoleDefinition(roleId);

  return {
    id: typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : role.displayName,
    roleId,
    shellType: 'powershell',
    executable: typeof input.executable === 'string' && input.executable.trim() ? input.executable.trim() : undefined,
    arguments: Array.isArray(input.arguments) ? input.arguments.filter((entry): entry is string => typeof entry === 'string') : [],
    workingDirectory:
      typeof input.workingDirectory === 'string' && input.workingDirectory.trim() ? input.workingDirectory.trim() : undefined,
    startupCommand:
      typeof input.startupCommand === 'string' ? input.startupCommand : role.defaultStartupCommand,
    envVars: isStringRecord(input.envVars) ? input.envVars : {},
    autoStart: typeof input.autoStart === 'boolean' ? input.autoStart : true,
  };
}

export function sanitizePersistedState(input: unknown): PersistedAppState {
  const defaults = createDefaultAppState();
  const candidate =
    typeof input === 'object' && input !== null && 'state' in input
      ? (input as PersistedStateEnvelope).state
      : (input as Partial<PersistedAppState> | null);

  if (!candidate || typeof candidate !== 'object') {
    return defaults;
  }

  const settingsCandidate = candidate.settings;
  const roles = Array.isArray(candidate.roles) ? candidate.roles.map(sanitizeRoleDefinition) : defaults.roles;
  const presets = Array.isArray(candidate.presets) ? candidate.presets.map(sanitizePreset) : defaults.presets;
  const projectSpaces = Array.isArray(candidate.projectSpaces)
    ? candidate.projectSpaces.map((space) => sanitizeProjectSpace(space, presets))
    : [];

  return {
    settings: {
      restoreOpenProjectSpaces:
        typeof settingsCandidate?.restoreOpenProjectSpaces === 'boolean'
          ? settingsCandidate.restoreOpenProjectSpaces
          : defaults.settings.restoreOpenProjectSpaces,
      rememberRecentProjectPaths:
        typeof settingsCandidate?.rememberRecentProjectPaths === 'boolean'
          ? settingsCandidate.rememberRecentProjectPaths
          : defaults.settings.rememberRecentProjectPaths,
      recentProjectPaths: Array.isArray(settingsCandidate?.recentProjectPaths)
        ? settingsCandidate.recentProjectPaths.filter((entry): entry is string => typeof entry === 'string').slice(0, 12)
        : defaults.settings.recentProjectPaths,
      lastActiveSpaceId:
        typeof settingsCandidate?.lastActiveSpaceId === 'string' || settingsCandidate?.lastActiveSpaceId === null
          ? settingsCandidate.lastActiveSpaceId
          : defaults.settings.lastActiveSpaceId,
      terminalFontFace:
        typeof settingsCandidate?.terminalFontFace === 'string' && settingsCandidate.terminalFontFace.trim()
          ? settingsCandidate.terminalFontFace.trim()
          : defaults.settings.terminalFontFace,
      terminalFontSize:
        typeof settingsCandidate?.terminalFontSize === 'number' && settingsCandidate.terminalFontSize >= 8
          ? settingsCandidate.terminalFontSize
          : defaults.settings.terminalFontSize,
      terminalLineHeight:
        typeof settingsCandidate?.terminalLineHeight === 'number' && settingsCandidate.terminalLineHeight > 0.7
          ? settingsCandidate.terminalLineHeight
          : defaults.settings.terminalLineHeight,
      terminalLetterSpacing:
        typeof settingsCandidate?.terminalLetterSpacing === 'number'
          ? settingsCandidate.terminalLetterSpacing
          : defaults.settings.terminalLetterSpacing,
      theme: 'dark',
      windowState: sanitizeWindowState(settingsCandidate?.windowState),
    },
    roles: roles.length ? roles : defaults.roles,
    presets: presets.length ? presets : defaults.presets,
    projectSpaces,
  };
}

export function trimTerminalBuffer(buffer: string): string {
  const maxChars = 200_000;
  return buffer.length <= maxChars ? buffer : buffer.slice(buffer.length - maxChars);
}

function sanitizeRoleDefinition(input: Partial<RoleDefinition>): RoleDefinition {
  const fallback = DEFAULT_ROLE_DEFINITIONS[0];

  return {
    id: typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    displayName:
      typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : fallback.displayName,
    description: typeof input.description === 'string' ? input.description : '',
    executableCommand:
      typeof input.executableCommand === 'string' && input.executableCommand.trim()
        ? input.executableCommand.trim()
        : undefined,
    argsTemplate: Array.isArray(input.argsTemplate)
      ? input.argsTemplate.filter((entry): entry is string => typeof entry === 'string')
      : [],
    defaultStartupCommand:
      typeof input.defaultStartupCommand === 'string' ? input.defaultStartupCommand : undefined,
    envVars: isStringRecord(input.envVars) ? input.envVars : {},
    accent: typeof input.accent === 'string' && input.accent ? input.accent : fallback.accent,
  };
}

function sanitizePreset(input: Partial<Preset>): Preset {
  const now = new Date().toISOString();
  const layoutId = isLayoutTemplateId(input.layoutTemplateId) ? input.layoutTemplateId : '4';
  const paneDefinitions = Array.isArray(input.paneDefinitions) ? input.paneDefinitions.map((pane) => normalizePaneDefinition(pane)) : [];
  const layoutTree = sanitizeLayoutTree(input.layoutTree, paneDefinitions.map((pane) => pane.id));

  return {
    id: typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Preset',
    description: typeof input.description === 'string' ? input.description : '',
    layoutTemplateId: layoutId,
    paneDefinitions: layoutTree ? paneDefinitions : coercePaneDefinitions(layoutId, paneDefinitions),
    layoutTree,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
  };
}

function sanitizeProjectSpace(input: Partial<ProjectSpace>, presets: Preset[]): ProjectSpace {
  const now = new Date().toISOString();
  const layoutId = isLayoutTemplateId(input.layoutTemplateId) ? input.layoutTemplateId : '4';
  const presetId = typeof input.presetId === 'string' ? input.presetId : null;
  const preset = presets.find((entry) => entry.id === presetId);
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath.trim() : '';
  const paneDefinitions = Array.isArray(input.paneDefinitions)
    ? input.paneDefinitions.map((pane) => normalizePaneDefinition(pane))
    : preset?.paneDefinitions ?? [];
  const layoutTree = sanitizeLayoutTree(input.layoutTree, paneDefinitions.map((pane) => pane.id));

  return {
    id: typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    displayName:
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim()
        : deriveDisplayNameFromPath(rootPath || 'Workspace'),
    rootPath,
    layoutTemplateId: layoutId,
    paneDefinitions: layoutTree ? paneDefinitions : coercePaneDefinitions(layoutId, paneDefinitions),
    layoutTree,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    presetId,
    isOpen: typeof input.isOpen === 'boolean' ? input.isOpen : true,
  };
}

function sanitizeWindowState(input: Partial<WindowStateSnapshot> | undefined): WindowStateSnapshot {
  return {
    width: typeof input?.width === 'number' ? input.width : DEFAULT_WINDOW_STATE.width,
    height: typeof input?.height === 'number' ? input.height : DEFAULT_WINDOW_STATE.height,
    x: typeof input?.x === 'number' ? input.x : undefined,
    y: typeof input?.y === 'number' ? input.y : undefined,
    isMaximized: typeof input?.isMaximized === 'boolean' ? input.isMaximized : false,
  };
}

export function buildLayoutTreeFromTemplate(layoutId: LayoutTemplateId, paneIds: string[]): LayoutNode | null {
  const template = getLayoutTemplate(layoutId);
  const ids = paneIds.slice(0, template.count);

  if (!ids.length) {
    return null;
  }

  if (template.rows === 1) {
    return buildSplitFromPaneIds(ids, 'horizontal');
  }

  if (template.columns === 1) {
    return buildSplitFromPaneIds(ids, 'vertical');
  }

  const rowNodes: LayoutNode[] = [];
  for (let rowIndex = 0; rowIndex < template.rows; rowIndex += 1) {
    const startIndex = rowIndex * template.columns;
    const rowIds = ids.slice(startIndex, startIndex + template.columns);
    if (rowIds.length) {
      rowNodes.push(buildSplitFromPaneIds(rowIds, 'horizontal'));
    }
  }

  return rowNodes.length === 1 ? rowNodes[0] : buildSplitFromNodes(rowNodes, 'vertical');
}

export function getNextTemplateForPaneCount(count: number): LayoutTemplateId {
  return LAYOUT_TEMPLATES.find((template) => template.count >= count)?.id ?? LAYOUT_TEMPLATES.at(-1)!.id;
}

export function splitLayoutTreeAtPane(
  layoutTree: LayoutNode,
  paneId: string,
  direction: LayoutSplitDirection,
  newPaneId: string,
): LayoutNode {
  if (layoutTree.type === 'leaf') {
    if (layoutTree.paneId !== paneId) {
      return layoutTree;
    }

    return {
      type: 'split',
      direction,
      children: [
        { type: 'leaf', paneId },
        { type: 'leaf', paneId: newPaneId },
      ],
    };
  }

  return {
    ...layoutTree,
    children: [
      splitLayoutTreeAtPane(layoutTree.children[0], paneId, direction, newPaneId),
      splitLayoutTreeAtPane(layoutTree.children[1], paneId, direction, newPaneId),
    ],
  };
}

export function removePaneFromLayoutTree(layoutTree: LayoutNode, paneId: string): LayoutNode | null {
  if (layoutTree.type === 'leaf') {
    return layoutTree.paneId === paneId ? null : layoutTree;
  }

  const leftNode = removePaneFromLayoutTree(layoutTree.children[0], paneId);
  const rightNode = removePaneFromLayoutTree(layoutTree.children[1], paneId);

  if (!leftNode && !rightNode) {
    return null;
  }

  if (!leftNode) {
    return rightNode;
  }

  if (!rightNode) {
    return leftNode;
  }

  return {
    ...layoutTree,
    children: [leftNode, rightNode],
  };
}

export function wrapPaneAtLayoutEdge(layoutTree: LayoutNode, paneId: string, edge: LayoutEdge): LayoutNode {
  const detachedNode = removePaneFromLayoutTree(layoutTree, paneId);
  if (!detachedNode) {
    return layoutTree;
  }

  const promotedLeaf: LayoutLeafNode = {
    type: 'leaf',
    paneId,
  };

  if (edge === 'left') {
    return {
      type: 'split',
      direction: 'horizontal',
      children: [promotedLeaf, detachedNode],
    };
  }

  if (edge === 'right') {
    return {
      type: 'split',
      direction: 'horizontal',
      children: [detachedNode, promotedLeaf],
    };
  }

  if (edge === 'top') {
    return {
      type: 'split',
      direction: 'vertical',
      children: [promotedLeaf, detachedNode],
    };
  }

  return {
    type: 'split',
    direction: 'vertical',
    children: [detachedNode, promotedLeaf],
  };
}

export function swapPaneIdsInLayoutTree(layoutTree: LayoutNode, leftPaneId: string, rightPaneId: string): LayoutNode {
  if (layoutTree.type === 'leaf') {
    return {
      type: 'leaf',
      paneId:
        layoutTree.paneId === leftPaneId
          ? rightPaneId
          : layoutTree.paneId === rightPaneId
            ? leftPaneId
            : layoutTree.paneId,
    };
  }

  return {
    ...layoutTree,
    children: [
      swapPaneIdsInLayoutTree(layoutTree.children[0], leftPaneId, rightPaneId),
      swapPaneIdsInLayoutTree(layoutTree.children[1], leftPaneId, rightPaneId),
    ],
  };
}

export function cloneLayoutTree(layoutTree: LayoutNode): LayoutNode {
  if (layoutTree.type === 'leaf') {
    return { type: 'leaf', paneId: layoutTree.paneId };
  }

  return {
    ...layoutTree,
    children: [cloneLayoutTree(layoutTree.children[0]), cloneLayoutTree(layoutTree.children[1])],
  };
}

export function remapLayoutTreePaneIds(layoutTree: LayoutNode, paneIdMap: Map<string, string>): LayoutNode {
  if (layoutTree.type === 'leaf') {
    return {
      type: 'leaf',
      paneId: paneIdMap.get(layoutTree.paneId) ?? layoutTree.paneId,
    };
  }

  return {
    ...layoutTree,
    children: [
      remapLayoutTreePaneIds(layoutTree.children[0], paneIdMap),
      remapLayoutTreePaneIds(layoutTree.children[1], paneIdMap),
    ],
  };
}

function isLayoutTemplateId(value: unknown): value is LayoutTemplateId {
  return typeof value === 'string' && LAYOUT_TEMPLATE_IDS.includes(value as LayoutTemplateId);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function sanitizeLayoutTree(input: unknown, validPaneIds: string[]): LayoutNode | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const validPaneIdSet = new Set(validPaneIds);
  const candidate = input as Partial<LayoutNode>;
  if (candidate.type === 'leaf') {
    return typeof candidate.paneId === 'string' && validPaneIdSet.has(candidate.paneId)
      ? { type: 'leaf', paneId: candidate.paneId }
      : null;
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    const direction = candidate.direction === 'vertical' ? 'vertical' : candidate.direction === 'horizontal' ? 'horizontal' : null;
    const leftNode = sanitizeLayoutTree(candidate.children[0], validPaneIds);
    const rightNode = sanitizeLayoutTree(candidate.children[1], validPaneIds);

    if (!direction || !leftNode || !rightNode) {
      return null;
    }

    return {
      type: 'split',
      direction,
      children: [leftNode, rightNode],
    };
  }

  return null;
}

function buildSplitFromPaneIds(paneIds: string[], direction: LayoutSplitDirection): LayoutNode {
  return buildSplitFromNodes(paneIds.map((paneId) => ({ type: 'leaf', paneId }) satisfies LayoutLeafNode), direction);
}

function buildSplitFromNodes(nodes: LayoutNode[], direction: LayoutSplitDirection): LayoutNode {
  if (nodes.length === 1) {
    return nodes[0];
  }

  const midpoint = Math.ceil(nodes.length / 2);
  return {
    type: 'split',
    direction,
    children: [
      buildSplitFromNodes(nodes.slice(0, midpoint), direction),
      buildSplitFromNodes(nodes.slice(midpoint), direction),
    ],
  };
}
