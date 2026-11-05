import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitService, parsePorcelainV2, type GitStatus } from './git-service';

const NUL = '\0';

function record(...fields: string[]): string {
  return fields.map((field) => field + NUL).join('');
}

describe('parsePorcelainV2', () => {
  it('parses branch headers and counts staged, unstaged, untracked and conflicted entries', () => {
    const output = record(
      '# branch.oid 4f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e',
      '# branch.head feature/my branch',
      '# branch.upstream origin/feature/my branch',
      '# branch.ab +3 -1',
      '1 M. N... 100644 100644 100644 aaaa bbbb src/staged.ts',
      '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged file.ts',
      '1 MM N... 100644 100644 100644 aaaa bbbb both.ts',
      '1 A. N... 000000 100644 100644 0000 cccc added.ts',
      '1 .D N... 100644 100644 000000 aaaa aaaa deleted.ts',
      '2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts',
      '? untracked one.txt',
      '? untracked-two.txt',
      '! ignored.log',
    );
    expect(parsePorcelainV2(output)).toEqual({
      branch: 'feature/my branch',
      detached: false,
      upstream: 'origin/feature/my branch',
      ahead: 3,
      behind: 1,
      dirty: true,
      staged: 4,
      unstaged: 3,
      untracked: 2,
      conflicted: 1,
    });
  });

  it('does not mistake a rename source path for a record', () => {
    // The original path of a rename looks like an untracked record ("? ...") on purpose.
    const output = record('# branch.oid abc1234def', '# branch.head main', '2 .M N... 100644 100644 100644 a a R090 b.txt', '? looks-untracked.txt');
    expect(parsePorcelainV2(output)).toMatchObject({ staged: 0, unstaged: 1, untracked: 0 });
  });

  it('handles detached HEAD, initial commits, no upstream and clean trees', () => {
    expect(parsePorcelainV2(record('# branch.oid 4f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e', '# branch.head (detached)')))
      .toMatchObject({ branch: '4f2c1d0', detached: true, upstream: null, ahead: 0, behind: 0, dirty: false });
    expect(parsePorcelainV2(record('# branch.oid (initial)', '# branch.head main', '? a.txt')))
      .toMatchObject({ branch: 'main', detached: false, untracked: 1, dirty: true });
    expect(parsePorcelainV2('')).toMatchObject({ branch: 'HEAD', dirty: false });
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Lookout Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function nextStatus(service: GitService, cwd: string, predicate: (status: GitStatus | null) => boolean, timeout = 5000): Promise<GitStatus | null> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`No matching git status for ${cwd} within ${timeout} ms`));
    }, timeout);
    const stop = service.watch(cwd, (status) => {
      if (!predicate(status)) return;
      clearTimeout(timer);
      queueMicrotask(stop);
      resolvePromise(status);
    });
  });
}

describe('GitService (live)', () => {
  let service: GitService;
  let temp: string;

  beforeEach(async () => {
    service = new GitService({ debounceMs: 50 });
    temp = await realpath(await mkdtemp(join(tmpdir(), 'lookout-git-')));
  });

  afterEach(async () => {
    service.dispose();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reports the status of this repository', async () => {
    const repoRoot = resolve(git(process.cwd(), 'rev-parse', '--show-toplevel'));
    const branch = git(process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD');
    const status = await nextStatus(service, join(process.cwd(), 'electron'), () => true);
    expect(status).not.toBeNull();
    expect(status!.repoRoot.toLowerCase()).toBe(repoRoot.toLowerCase());
    expect(status!.detached).toBe(branch === 'HEAD');
    if (branch !== 'HEAD') expect(status!.branch).toBe(branch);
    console.log(`live status of ${status!.repoRoot}: ${JSON.stringify(status)}`);
  });

  it('never rewrites the index (GIT_OPTIONAL_LOCKS=0), unlike a plain git status', async () => {
    git(temp, 'init', '-q', '-b', 'main');
    await writeFile(join(temp, 'a.txt'), 'same');
    git(temp, 'add', 'a.txt');
    git(temp, 'commit', '-q', '-m', 'init');
    const indexPath = join(temp, '.git', 'index');
    const touch = async () => {
      // Same content, newer mtime: the index entry's stat data is stale, so git would like to refresh it.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      await writeFile(join(temp, 'a.txt'), 'same');
    };

    await touch();
    const before = (await stat(indexPath)).mtimeMs;
    const status = await nextStatus(service, temp, () => true);
    expect(status).toMatchObject({ dirty: false });
    expect((await stat(indexPath)).mtimeMs).toBe(before);

    // Control: a normal `git status` does take the lock and rewrites the index here.
    git(temp, 'status', '--porcelain');
    expect((await stat(indexPath)).mtimeMs).not.toBe(before);
  });

  it('reports null outside a repository', async () => {
    const plain = join(temp, 'plain');
    await mkdir(plain);
    // The temp dir could itself be inside a repo on unusual setups; skip then.
    let inside = true;
    try {
      git(plain, 'rev-parse', '--show-toplevel');
    } catch {
      inside = false;
    }
    if (inside) return;
    await expect(nextStatus(service, plain, () => true)).resolves.toBeNull();
  });

  it('follows index changes via the watcher and working-tree changes via refresh()', async () => {
    git(temp, 'init', '-q', '-b', 'main');
    const seen: Array<GitStatus | null> = [];
    const stop = service.watch(temp, (status) => seen.push(status));
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ branch: 'main', dirty: false }), { timeout: 5000, interval: 25 });

    await writeFile(join(temp, 'a.txt'), 'hello');
    service.refresh(temp);
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ untracked: 1, dirty: true }), { timeout: 5000, interval: 25 });

    // `git add` rewrites .git/index: picked up by the watcher, no refresh() needed.
    git(temp, 'add', 'a.txt');
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ staged: 1, untracked: 0 }), { timeout: 5000, interval: 25 });

    // Committing moves HEAD/index; then a branch switch changes HEAD.
    git(temp, 'commit', '-q', '-m', 'init');
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ dirty: false, staged: 0 }), { timeout: 5000, interval: 25 });
    git(temp, 'switch', '-q', '-c', 'feature');
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ branch: 'feature' }), { timeout: 5000, interval: 25 });
    stop();
  });

  it('shares one repo entry between folders, refcounts listeners and supports worktrees', async () => {
    const main = join(temp, 'main');
    await mkdir(join(main, 'sub'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    await writeFile(join(main, 'sub', 'f.txt'), 'x');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'side', join(temp, 'wt'));

    const [rootStatus, subStatus, worktreeStatus] = await Promise.all([
      nextStatus(service, main, () => true),
      nextStatus(service, join(main, 'sub'), () => true),
      nextStatus(service, join(temp, 'wt'), () => true),
    ]);
    expect(rootStatus).toMatchObject({ branch: 'main', dirty: false });
    expect(subStatus!.repoRoot).toBe(rootStatus!.repoRoot);
    expect(worktreeStatus).toMatchObject({ branch: 'side', repoRoot: resolve(join(temp, 'wt')) });

    // Two watchers on one repo share state; after both unsubscribe the entry is released.
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = service.watch(main, first);
    const stopSecond = service.watch(join(main, 'sub'), second);
    await vi.waitFor(() => expect(first).toHaveBeenCalled(), { timeout: 5000, interval: 25 });
    await vi.waitFor(() => expect(second).toHaveBeenCalled(), { timeout: 5000, interval: 25 });
    const repos = (service as unknown as { repos: Map<string, unknown> }).repos;
    expect(repos.size).toBe(1);
    stopFirst();
    expect(repos.size).toBe(1);
    stopSecond();
    expect(repos.size).toBe(0);
  });

  it('reports null when git is missing', async () => {
    const missing = new GitService({ gitPath: join(temp, 'no-such-git.exe') });
    try {
      await expect(nextStatus(missing, process.cwd(), () => true)).resolves.toBeNull();
    } finally {
      missing.dispose();
    }
  });
});
