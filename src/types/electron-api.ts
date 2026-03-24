import type { PersistedAppState, TerminalEvent, TerminalLaunchRequest, TerminalLaunchResponse, ValidationResponse } from './app';

export interface LoadStateResponse {
  state: PersistedAppState;
  warnings: string[];
}

export interface LookoutApi {
  loadAppState: () => Promise<LoadStateResponse>;
  saveAppState: (state: PersistedAppState) => Promise<void>;
  listLocalFonts: () => Promise<string[]>;
  pickDirectory: (initialPath?: string) => Promise<string | null>;
  validateDirectory: (inputPath: string) => Promise<ValidationResponse>;
  openPath: (inputPath: string) => Promise<void>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  startTerminalSession: (request: TerminalLaunchRequest) => Promise<TerminalLaunchResponse>;
  stopTerminalSession: (sessionId: string) => Promise<void>;
  writeTerminalData: (sessionId: string, data: string) => Promise<void>;
  resizeTerminalSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void;
}
