import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJsonWithBackup, writeFileAtomic } from './atomic-file';
import { parseJsonc } from './profiles/jsonc';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lookout-atomic-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates the file (and missing folders) without leaving temp files', async () => {
    const path = join(dir, 'nested', 'state.json');
    await writeFileAtomic(path, '{"a":1}');
    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('keeps the previous good file as .bak', async () => {
    const path = join(dir, 'state.json');
    await writeFileAtomic(path, '{"v":1}');
    await writeFileAtomic(path, '{"v":2}');
    expect(await readFile(path, 'utf8')).toBe('{"v":2}');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('{"v":1}');
    expect((await readdir(dir)).sort()).toEqual(['state.json', 'state.json.bak']);
  });

  it('never replaces a good backup with a corrupt current file', async () => {
    const path = join(dir, 'state.json');
    await writeFileAtomic(path, '{"v":1}');
    await writeFileAtomic(path, '{"v":2}');
    await writeFile(path, '{"v":', 'utf8'); // truncated by some other writer
    await writeFileAtomic(path, '{"v":3}');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('{"v":1}');
    expect(await readFile(path, 'utf8')).toBe('{"v":3}');
  });

  it('accepts JSONC as a good backup and honours custom checks / backup: false', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '// comment\n{ "a": 1, }', 'utf8');
    await writeFileAtomic(path, '{"a":2}');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('// comment\n{ "a": 1, }');

    const buffer = join(dir, 'pane.vt');
    await writeFileAtomic(buffer, 'one', { backup: false });
    await writeFileAtomic(buffer, 'two', { backup: false });
    expect((await readdir(dir)).includes('pane.vt.bak')).toBe(false);

    const custom = join(dir, 'custom.txt');
    await writeFileAtomic(custom, 'bad');
    await writeFileAtomic(custom, 'next', { isGood: (current) => current !== 'bad' });
    expect((await readdir(dir)).includes('custom.txt.bak')).toBe(false);
  });

  it('cleans up the temp file when the target cannot be replaced', async () => {
    const path = join(dir, 'target');
    await writeFile(join(dir, 'blocker'), 'x');
    // Renaming a file over a non-empty directory fails on every platform.
    await writeFileAtomic(join(path, 'inner'), 'x');
    await expect(writeFileAtomic(path, 'data')).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('handles concurrent writes to the same file', async () => {
    const path = join(dir, 'state.json');
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFileAtomic(path, JSON.stringify({ index }))));
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('index');
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('readJsonWithBackup', () => {
  const now = () => new Date('2026-11-03T21:40:37.123Z');

  it('reads the primary file', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '\uFEFF{"ok":true}');
    expect(await readJsonWithBackup(path)).toMatchObject({ value: { ok: true }, source: 'primary' });
  });

  it('reports none when neither file exists', async () => {
    expect(await readJsonWithBackup(join(dir, 'missing.json'))).toEqual({ value: undefined, source: 'none', error: undefined, corruptPath: undefined });
  });

  it('falls back to .bak when the primary is missing', async () => {
    const path = join(dir, 'state.json');
    await writeFile(`${path}.bak`, '{"from":"bak"}');
    const result = await readJsonWithBackup(path);
    expect(result).toMatchObject({ value: { from: 'bak' }, source: 'backup' });
    expect(result.error).toBeUndefined();
  });

  it('moves a corrupt primary aside and uses the backup (the v1 data-loss bug)', async () => {
    const path = join(dir, 'state.json');
    await writeFileAtomic(path, '{"v":1}');
    await writeFileAtomic(path, '{"v":2}');
    await writeFile(path, '{"v":2, "trunc');
    const result = await readJsonWithBackup(path, { now });
    expect(result.source).toBe('backup');
    expect(result.value).toEqual({ v: 1 });
    expect(result.corruptPath).toBe(`${path}.corrupt-2026-11-03T21-40-37-123Z`);
    expect(result.error).toContain('could not be parsed');
    expect(await readFile(result.corruptPath!, 'utf8')).toBe('{"v":2, "trunc');
    expect((await readdir(dir)).includes('state.json')).toBe(false);
  });

  it('treats an empty file as corrupt', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '');
    const result = await readJsonWithBackup(path, { now });
    expect(result.source).toBe('none');
    expect(result.error).toContain('empty');
    expect(result.corruptPath).toBeDefined();
  });

  it('reports an unusable backup', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, 'nope');
    await writeFile(`${path}.bak`, 'also nope');
    const result = await readJsonWithBackup(path, { now });
    expect(result.source).toBe('none');
    expect(result.error).toContain('backup');
  });

  it('supports a custom parser (JSONC)', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{ // hi\n "a": [1,], }');
    expect((await readJsonWithBackup(path, { parse: parseJsonc })).value).toEqual({ a: [1] });
  });
});
