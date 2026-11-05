// Live git status for pane folders. One fs watcher and at most one running
// `git status` per repository, shared by every pane in it. Status runs with
// GIT_OPTIONAL_LOCKS=0 so Lookout never takes index.lock and can never make the
// user's own git commands fail with "index.lock exists".

import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';

export interface GitStatus {
  repoRoot: string;
  /** Branch name; the short commit id when detached. */
  branch: string;
  detached: boolean;
  /** e.g. `origin/main`; null without an upstream. */
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export type GitStatusListener = (status: GitStatus | null) => void;

export interface GitServiceOptions {
  gitPath?: string;
  /** Debounce between a change event and `git status`. Default 250 ms. */
  debounceMs?: number;
  /** Kill `git status` after this long. Default 5 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Files in the git dir whose change can alter status (HEAD, index, fetch/merge results, refs). */
const RELEVANT_GIT_FILES = new Set([
  'head', 'index', 'fetch_head', 'orig_head', 'merge_head', 'cherry_pick_head', 'revert_head',
  'rebase_head', 'auto_merge', 'packed-refs', 'refs', 'rebase-merge', 'rebase-apply',
]);
const NEGATIVE_CACHE_MS = 5_000;

/** Parses `git status --porcelain=v2 --branch -z` output. */
export function parsePorcelainV2(output: string): Omit<GitStatus, 'repoRoot'> {
  const result: Omit<GitStatus, 'repoRoot'> = {
    branch: '', detached: false, upstream: null, ahead: 0, behind: 0,
    dirty: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
  };
  let oid = '';
  let head = '';
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith('# ')) {
      const [, key, ...rest] = field.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') oid = value;
      else if (key === 'branch.head') head = value;
      else if (key === 'branch.upstream') result.upstream = value || null;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = field[0];
    if (kind === '1' || kind === '2') {
      const x = field[2];
      const y = field[3];
      if (x && x !== '.') result.staged += 1;
      if (y && y !== '.') result.unstaged += 1;
      // With -z a rename/copy record is followed by its original path as a separate field.
      if (kind === '2') index += 1;
    } else if (kind === 'u') {
      result.conflicted += 1;
    } else if (kind === '?') {
      result.untracked += 1;
    }
  }

  if (head === '(detached)') {
    result.detached = true;
    result.branch = /^[0-9a-f]{7,}$/i.test(oid) ? oid.slice(0, 7) : 'HEAD';
  } else {
    result.branch = head || 'HEAD';
  }
  result.dirty = result.staged + result.unstaged + result.untracked + result.conflicted > 0;
  return result;
}

function sameStatus(left: GitStatus | null, right: GitStatus | null): boolean {
  if (left === null || right === null) return left === right;
  return (Object.keys(left) as Array<keyof GitStatus>).every((key) => left[key] === right[key]);
}

interface RepoInfo {
  key: string;
  root: string;
  gitDir: string;
}

interface RepoEntry extends RepoInfo {
  listeners: Set<GitStatusListener>;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  pending: boolean;
  status: GitStatus | null;
  hasStatus: boolean;
  disposed: boolean;
}

interface Subscription {
  cwdKey: string;
  cwd: string;
  listener: GitStatusListener;
  repo: RepoEntry | null;
  active: boolean;
}

class GitError extends Error {
  readonly code: string | number | undefined;
  readonly killed: boolean;

  constructor(message: string, code: string | number | undefined, killed: boolean) {
    super(message);
    this.code = code;
    this.killed = killed;
  }
}

function cwdKeyOf(cwd: string): string {
  return resolve(cwd).toLowerCase();
}

export class GitService {
  private readonly gitPath: string;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repos = new Map<string, RepoEntry>();
  private readonly resolveCache = new Map<string, { at: number; promise: Promise<RepoInfo | null> }>();
  private readonly subscriptions = new Set<Subscription>();
  private gitMissingUntil = 0;
  private disposed = false;

  constructor(options: GitServiceOptions = {}) {
    this.gitPath = options.gitPath ?? 'git';
    this.debounceMs = options.debounceMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.env = { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  }

  /**
   * Calls `listener` with the status of the repository containing `cwd` now and on
   * every change; with null when `cwd` is not in a repository (or git is missing).
   */
  watch(cwd: string, listener: GitStatusListener): () => void {
    const subscription: Subscription = { cwd, cwdKey: cwdKeyOf(cwd), listener, repo: null, active: true };
    if (this.disposed) {
      queueMicrotask(() => listener(null));
      return () => undefined;
    }
    this.subscriptions.add(subscription);
    void this.attach(subscription);
    return () => this.unsubscribe(subscription);
  }

  /** Re-checks `cwd` soon (e.g. after a command finished; working-tree edits are not watched). */
  refresh(cwd: string): void {
    if (this.disposed) return;
    const key = cwdKeyOf(cwd);
    const cached = this.resolveCache.get(key);
    let reattached = false;
    for (const subscription of this.subscriptions) {
      if (subscription.cwdKey !== key || subscription.repo) continue;
      // Not a repo before; it may be one now (git init / clone).
      if (!reattached) this.resolveCache.delete(key);
      reattached = true;
      void this.attach(subscription);
    }
    if (reattached || !cached) return;
    void cached.promise.then((info) => {
      const repo = info ? this.repos.get(info.key) : undefined;
      if (repo) this.schedule(repo);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const repo of this.repos.values()) this.closeRepo(repo);
    this.repos.clear();
    this.subscriptions.clear();
    this.resolveCache.clear();
  }

  // ---- Internals --------------------------------------------------------------

  private async attach(subscription: Subscription): Promise<void> {
    const info = await this.resolveRepo(subscription.cwd, subscription.cwdKey);
    if (!subscription.active || this.disposed) return;
    if (!info) {
      subscription.listener(null);
      return;
    }

    let repo = this.repos.get(info.key);
    if (!repo) {
      repo = { ...info, listeners: new Set(), watcher: null, timer: null, running: false, pending: false, status: null, hasStatus: false, disposed: false };
      this.repos.set(info.key, repo);
      this.startWatcher(repo);
    }
    subscription.repo = repo;
    repo.listeners.add(subscription.listener);
    if (repo.hasStatus) subscription.listener(repo.status);
    else if (!repo.running && !repo.timer) this.schedule(repo, 0);
  }

  private unsubscribe(subscription: Subscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    this.subscriptions.delete(subscription);
    const repo = subscription.repo;
    if (!repo) return;
    repo.listeners.delete(subscription.listener);
    if (!repo.listeners.size) {
      this.closeRepo(repo);
      this.repos.delete(repo.key);
    }
  }

  private closeRepo(repo: RepoEntry): void {
    repo.disposed = true;
    repo.watcher?.close();
    repo.watcher = null;
    if (repo.timer) clearTimeout(repo.timer);
    repo.timer = null;
    repo.listeners.clear();
  }

  private resolveRepo(cwd: string, key: string): Promise<RepoInfo | null> {
    const cached = this.resolveCache.get(key);
    if (cached) {
      // Repositories rarely disappear; "not a repository" is re-checked after a while.
      const promise = cached.promise;
      return promise.then((info) => {
        if (info || Date.now() - cached.at < NEGATIVE_CACHE_MS) return info;
        if (this.resolveCache.get(key) === cached) this.resolveCache.delete(key);
        return this.resolveRepo(cwd, key);
      });
    }

    const promise = this.git(['-C', resolve(cwd), 'rev-parse', '--show-toplevel', '--absolute-git-dir'])
      .then((stdout) => {
        const [root, gitDir] = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!root || !gitDir) return null;
        const resolvedGitDir = resolve(gitDir);
        return { key: resolvedGitDir.toLowerCase(), root: resolve(root), gitDir: resolvedGitDir };
      })
      .catch(() => null);
    this.resolveCache.set(key, { at: Date.now(), promise });
    return promise;
  }

  private startWatcher(repo: RepoEntry): void {
    try {
      // Non-recursive on the git dir: HEAD, index, FETCH_HEAD, ORIG_HEAD... For a
      // worktree --absolute-git-dir is .git/worktrees/<name>, which has its own HEAD and index.
      repo.watcher = watch(repo.gitDir, { persistent: false }, (_event, filename) => {
        const name = filename?.toString().toLowerCase();
        if (name && !RELEVANT_GIT_FILES.has(name)) return;
        this.schedule(repo);
      });
      repo.watcher.on('error', () => {
        // The git dir went away (repo deleted/moved): report once more, then stay quiet.
        repo.watcher?.close();
        repo.watcher = null;
        this.schedule(repo);
      });
    } catch {
      repo.watcher = null;
    }
  }

  private schedule(repo: RepoEntry, delay = this.debounceMs): void {
    if (repo.disposed || this.disposed) return;
    if (repo.running) {
      repo.pending = true;
      return;
    }
    if (repo.timer) clearTimeout(repo.timer);
    repo.timer = setTimeout(() => {
      repo.timer = null;
      void this.run(repo);
    }, delay);
  }

  private async run(repo: RepoEntry): Promise<void> {
    repo.running = true;
    repo.pending = false;
    let status: GitStatus | null | undefined;
    try {
      const stdout = await this.git(['-C', repo.root, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
      status = { repoRoot: repo.root, ...parsePorcelainV2(stdout) };
    } catch (error) {
      // A timeout keeps the last known status; anything else (repo gone, git missing) means "no status".
      status = error instanceof GitError && error.killed ? undefined : null;
    }
    repo.running = false;
    if (repo.disposed || this.disposed) return;

    if (status !== undefined && (!repo.hasStatus || !sameStatus(status, repo.status))) {
      repo.status = status;
      repo.hasStatus = true;
      for (const listener of [...repo.listeners]) {
        try {
          listener(status);
        } catch {
          // Ignore listener failures.
        }
      }
    }
    if (repo.pending) this.schedule(repo);
  }

  private git(args: string[]): Promise<string> {
    if (Date.now() < this.gitMissingUntil) return Promise.reject(new GitError('git is not installed', 'ENOENT', false));
    return new Promise((resolvePromise, reject) => {
      execFile(this.gitPath, args, {
        env: this.env,
        windowsHide: true,
        timeout: this.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => {
        if (!error) {
          resolvePromise(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
        if (code === 'ENOENT') this.gitMissingUntil = Date.now() + 60_000;
        reject(new GitError(error.message, code, Boolean((error as { killed?: boolean }).killed)));
      });
    });
  }
}
