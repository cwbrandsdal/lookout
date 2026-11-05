import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSshConfigHosts, parseSshConfigHosts } from './ssh-config';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('SSH config', () => {
  it('extracts concrete aliases, handles quotes/comments/case/equals, and ignores patterns', () => {
    expect(parseSshConfigHosts(`\uFEFF# user config
Host devbox buildbox *.internal !blocked host?name
  HostName never-an-alias
hOsT="quoted-alias" DEVBOX # comment
Host = spaced-equals
Match host ignored
Host literal\\#hash
`)).toEqual(['devbox', 'buildbox', 'quoted-alias', 'spaced-equals', 'literal#hash']);
  });

  it('follows ordered glob, quoted, home-relative and nested Includes with cycle protection', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lookout-ssh-'));
    folders.push(folder);
    await mkdir(join(folder, 'conf.d'));
    await writeFile(join(folder, 'config'), 'Host root\nInclude "conf.d/*.conf" "space file"\nHost last');
    await writeFile(join(folder, 'conf.d', 'a.conf'), 'Host alpha\nInclude conf.d/b.conf\nInclude config');
    await writeFile(join(folder, 'conf.d', 'b.conf'), 'Host beta alpha\nInclude ~/.ssh-missing\nInclude %SSH_EXTRA%');
    await writeFile(join(folder, 'extra'), 'Host extra');
    await writeFile(join(folder, 'space file'), 'Host spaced\nInclude missing');
    expect(await loadSshConfigHosts(join(folder, 'config'), { env: { USERPROFILE: folder, SSH_EXTRA: join(folder, 'extra') } }))
      .toEqual(['root', 'alpha', 'beta', 'extra', 'spaced', 'last']);
    expect(await loadSshConfigHosts(join(folder, 'missing'))).toEqual([]);
    expect(await loadSshConfigHosts(join(folder, 'config'), { maxDepth: 0 })).toEqual(['root', 'last']);
  });
});
