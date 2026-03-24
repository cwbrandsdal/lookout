import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultAppState, type PersistedAppState, type PersistedStateEnvelope, sanitizePersistedState } from '../src/types/app';

const STATE_FILE_NAME = 'lookout-state.json';
const STATE_VERSION = 1;

export interface LoadPersistedStateResult {
  state: PersistedAppState;
  warnings: string[];
}

export async function loadPersistedState(): Promise<LoadPersistedStateResult> {
  const filePath = getStateFilePath();

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedStateEnvelope;

    return {
      state: sanitizePersistedState(parsed),
      warnings: [],
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        state: createDefaultAppState(),
        warnings: [],
      };
    }

    return {
      state: createDefaultAppState(),
      warnings: ['Stored app state was unreadable. Lookout reverted to a fresh local state file.'],
    };
  }
}

export async function savePersistedState(state: PersistedAppState): Promise<void> {
  const filePath = getStateFilePath();
  const envelope: PersistedStateEnvelope = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    state,
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');
}

function getStateFilePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE_NAME);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
