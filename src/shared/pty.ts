// Contracts for the pty host (Electron utilityProcess). No DOM or Electron imports.

import type { ShellKind } from './settings';

/** Minimal pty-like surface the pty host needs; node-pty's IPty satisfies it. */
export interface PtyLike {
  /** Pid of the process the user sees (the shell or the handed-off client). */
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause?(): void;
  resume?(): void;
}

/** A console session that Windows handed to Lookout (default-terminal handoff). */
export interface HandoffOffer {
  pty: PtyLike;
  /** Initial title, usually the client executable path. */
  title?: string;
  commandLine?: string;
  cwd?: string;
  cols: number;
  rows: number;
  /** True when the client runs elevated. */
  elevated?: boolean;
}

export interface HandoffServer {
  close(): void;
}

/** What the pty host should spawn for a profile/pane. Produced by `buildShellLaunch`. */
export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  shellKind: ShellKind;
  /** Whether Lookout shell integration was injected. */
  integrated: boolean;
}

export interface ShellLaunchInput {
  /** Full Windows command line from the profile (may contain %VAR%). */
  commandline: string;
  /** Run once the shell is up (e.g. `claude`). */
  startupCommand?: string;
  /** Absolute, already-validated working directory. */
  cwd: string;
  shellIntegration: boolean;
  /** Absolute directory that contains lookout.ps1 / lookout.bash. */
  shellIntegrationDir: string;
  /** Base environment (process env + profile env + Lookout vars). */
  env: Record<string, string>;
}
