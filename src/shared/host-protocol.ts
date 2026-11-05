// Message protocol of the pty host (an Electron utilityProcess that owns every
// shell). Renderers talk to it over a dedicated MessagePort per window; the
// main process talks to it over `process.parentPort`.
//
// Ownership: every session belongs to a window id. A session created over a
// window's port is owned by that window. `attach` over a port transfers the
// session to that port's window (used after a renderer reload and when a tab
// moves to another window). Sessions survive renderer reloads; they only die
// when killed, when they exit, or when their window is closed for good.
//
// Flow control: the host counts characters sent to the owner that the owner
// has not yet acknowledged. The renderer acks after xterm has parsed the data
// (`terminal.write(data, callback)`). Above FLOW_HIGH_WATERMARK the pty is
// paused; it resumes below FLOW_LOW_WATERMARK. Values match VS Code.

import type { ShellKind } from './settings';

export const FLOW_HIGH_WATERMARK = 100_000;
export const FLOW_LOW_WATERMARK = 5_000;
export const FLOW_ACK_BATCH = 5_000;

export interface LaunchSpec {
  profileId: string;
  /** Full Windows command line; %VAR% expanded by the host. */
  commandline: string;
  startupCommand?: string;
  /** Requested working directory; the host validates it and falls back to the user's home. */
  cwd?: string;
  /** Extra environment (profile env); merged over a freshly read system/user environment. */
  env?: Record<string, string>;
  shellIntegration: boolean;
  /**
   * Start ConPTY at the terminal's current cursor position instead of a blank
   * screen (used after restoring scrollback, so the new shell continues below it).
   */
  inheritCursor?: boolean;
  /** Restored scrollback the renderer already shows; written to the host's mirror so later snapshots include it. */
  restoredBuffer?: string;
}

export interface SessionInfo {
  sessionId: string;
  paneId: string | null;
  kind: 'shell' | 'handoff';
  pid: number;
  shellKind: ShellKind;
  integrated: boolean;
  /** Launch directory (the renderer tracks the live cwd via shell integration). */
  cwd: string;
  cols: number;
  rows: number;
  title?: string;
  commandLine?: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
}

// ---- Renderer -> host -------------------------------------------------------

export type RendererToHost =
  | { type: 'create'; requestId: string; paneId: string; launch: LaunchSpec; cols: number; rows: number }
  | { type: 'attach'; requestId: string; sessionId: string; paneId: string; cols: number; rows: number }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'ack'; sessionId: string; chars: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list'; requestId: string };

// ---- Host -> renderer -------------------------------------------------------

export type HostToRenderer =
  | { type: 'create-result'; requestId: string; ok: true; session: SessionInfo }
  | { type: 'create-result'; requestId: string; ok: false; error: string }
  /** `snapshot` is the serialized terminal state (xterm SerializeAddon) to write before live data. */
  | { type: 'attach-result'; requestId: string; ok: true; session: SessionInfo; snapshot: string }
  | { type: 'attach-result'; requestId: string; ok: false; error: string }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number }
  | { type: 'list-result'; requestId: string; sessions: SessionInfo[] };

// ---- Main -> host -----------------------------------------------------------

export type MainToHost =
  | { type: 'init'; shellIntegrationDir: string; handoffPipeName: string | null; windowsBuild: number; scrollback: number }
  /** `ports[0]` of the message event is the window's MessagePort. Replaces any previous port for that window. */
  | { type: 'connect-window'; windowId: string }
  /** The window is gone. `killSessions: false` keeps its sessions alive (e.g. tab moved / app quitting with serialization done). */
  | { type: 'disconnect-window'; windowId: string; killSessions: boolean }
  | { type: 'serialize'; requestId: string; scrollbackLines: number }
  | { type: 'list'; requestId: string }
  | { type: 'kill-all'; requestId: string }
  | { type: 'set-scrollback'; scrollback: number };

// ---- Host -> main -----------------------------------------------------------

export interface SerializedBuffer {
  sessionId: string;
  paneId: string | null;
  ownerWindowId: string | null;
  data: string;
}

export type HostToMain =
  | { type: 'ready' }
  | { type: 'serialize-result'; requestId: string; buffers: SerializedBuffer[] }
  | { type: 'list-result'; requestId: string; sessions: Array<SessionInfo & { ownerWindowId: string | null }> }
  | { type: 'kill-all-result'; requestId: string }
  /** A console was handed to Lookout by Windows; main picks a window, which then sends `attach`. */
  | { type: 'handoff-arrived'; session: SessionInfo }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
