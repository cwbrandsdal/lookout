import { execFile } from 'node:child_process';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expandEnvVars, getEnv, joinCommandLine, quoteArg } from '../../src/shared/commandline';
import type { ProfileDefinition, ShellKind } from '../../src/shared/settings';
import { loadSshConfigHosts } from './ssh-config';

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    // Store AppExecLink aliases are runnable reparse points. stat follows them
    // and fails with EACCES, while lstat/access can verify the alias itself.
    if (!/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(file)) return false;
    try {
      await access(file);
      return (await lstat(file)).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { env, windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => resolve(error ? '' : stdout));
    } catch {
      resolve('');
    }
  });
}

function profile(id: string, name: string, commandline: string, shellKind: ShellKind): ProfileDefinition {
  return { id, name, commandline, shellKind, source: 'detected' };
}

/** Read-only, bounded probes. A failed or unavailable probe never prevents other discoveries. */
export async function detectProfiles(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProfileDefinition[]> {
  try {
    const env = options.env ?? process.env;
    const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs!) : 8_000;
    const systemRoot = getEnv(env, 'SystemRoot') ?? 'C:\\Windows';
    const system32 = join(systemRoot, 'System32');
    const local = getEnv(env, 'LOCALAPPDATA');
    const home = getEnv(env, 'USERPROFILE') ?? homedir();
    const programFiles = getEnv(env, 'ProgramW6432') ?? getEnv(env, 'ProgramFiles') ?? 'C:\\Program Files';
    const programFilesX86 = getEnv(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
    const probe = (file: string, args: string[]) => run(file, args, env, Math.min(timeout, 3_000));
    const where = (name: string) => probe(join(system32, 'where.exe'), [name]);
    const registry = (key: string, args: string[]) => probe(join(system32, 'reg.exe'), ['query', key, ...args]);

    const powershells = (async (): Promise<ProfileDefinition[]> => {
      const [onPath, folders] = await Promise.all([
        where('pwsh.exe'),
        readdir(join(programFiles, 'PowerShell')).catch(() => [] as string[]),
      ]);
      const stable = [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        ...(local ? [join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
        ...onPath.trim().split(/\r?\n/).filter(Boolean).filter((path) => !/preview/i.test(path)),
      ];
      const preview = [
        ...folders.filter((folder) => /preview/i.test(folder)).sort().map((folder) => join(programFiles, 'PowerShell', folder, 'pwsh.exe')),
        ...(local ? [join(local, 'Microsoft', 'WindowsApps', 'pwsh-preview.exe')] : []),
        ...onPath.trim().split(/\r?\n/).filter((path) => /preview/i.test(path)),
      ];
      const groups = await Promise.all([stable, preview].map(async (paths) => {
        const present = await Promise.all(paths.map(isFile));
        return paths.find((_, index) => present[index]);
      }));
      const result: ProfileDefinition[] = [];
      if (groups[0]) result.push(profile('pwsh', 'PowerShell', quoteArg(groups[0]), 'pwsh'));
      if (groups[1] && groups[1].toLowerCase() !== groups[0]?.toLowerCase()) {
        result.push(profile(groups[0] ? 'pwsh-preview' : 'pwsh', 'PowerShell Preview', quoteArg(groups[1]), 'pwsh'));
      }
      return result;
    })();

    const windowsShells = (async (): Promise<ProfileDefinition[]> => {
      const candidates = [
        profile('windows-powershell', 'Windows PowerShell', join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell'),
        profile('cmd', 'Command Prompt', join(system32, 'cmd.exe'), 'cmd'),
      ];
      const present = await Promise.all(candidates.map((item) => isFile(item.commandline)));
      return candidates.filter((_, index) => present[index]).map((item) => ({ ...item, commandline: quoteArg(item.commandline) }));
    })();

    const git = (async (): Promise<ProfileDefinition[]> => {
      const key = await registry('HKLM\\SOFTWARE\\GitForWindows', ['/v', 'InstallPath']);
      const install = key.match(/InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)?.[1].trim();
      const roots = [install, join(programFiles, 'Git'), join(programFilesX86, 'Git'),
        ...(local ? [join(local, 'Programs', 'Git')] : [])].filter((value): value is string => !!value);
      const paths = roots.map((root) => join(expandEnvVars(root, env), 'bin', 'bash.exe'));
      const present = await Promise.all(paths.map(isFile));
      const path = paths.find((_, index) => present[index]);
      return path ? [profile('git-bash', 'Git Bash', `"${path}" --login -i`, 'bash')] : [];
    })();

    const wsl = (async (): Promise<ProfileDefinition[]> => {
      const output = await registry('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', ['/s', '/v', 'DistributionName']);
      const names = [...output.matchAll(/DistributionName\s+REG_SZ\s+([^\r\n]+)/gi)]
        .map((match) => match[1].trim()).filter((name) => name && !/^docker-desktop/i.test(name));
      return [...new Set(names)].sort().map((name) => ({
        ...profile(`wsl-${slug(name)}`, name, joinCommandLine(['wsl.exe', '-d', name]), 'wsl'),
        startingDirectory: '~',
      }));
    })();

    const visualStudio = (async (): Promise<ProfileDefinition[]> => {
      const path = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
      if (!await isFile(path)) return [];
      const output = await probe(path, ['-all', '-prerelease', '-format', 'json']);
      if (!output) return [];
      const instances: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
      if (!Array.isArray(instances)) return [];
      const groups = await Promise.all(instances.map(async (value: unknown): Promise<ProfileDefinition[]> => {
        if (!value || typeof value !== 'object') return [];
        const instance = value as Record<string, unknown>;
        if (typeof instance.installationPath !== 'string' || typeof instance.instanceId !== 'string') return [];
        const catalog = instance.catalog as Record<string, unknown> | undefined;
        const major = String(instance.installationVersion ?? '').split('.')[0];
        const productLine = typeof catalog?.productLineVersion === 'string' ? catalog.productLineVersion : major;
        const suffix = `${productLine}${instance.isPrerelease ? ' [Preview]' : ''}`;
        const module = join(instance.installationPath, 'Common7', 'Tools', 'Microsoft.VisualStudio.DevShell.dll');
        const script = join(instance.installationPath, 'Common7', 'Tools', 'VsDevCmd.bat');
        const [hasModule, hasScript] = await Promise.all([isFile(module), isFile(script)]);
        const result: ProfileDefinition[] = [];
        if (hasModule) {
          result.push({
            ...profile(`vs-powershell-${slug(instance.instanceId)}`, `Developer PowerShell for VS ${suffix}`,
              `powershell.exe -NoExit -Command "&{Import-Module """${module}"""; Enter-VsDevShell ${instance.instanceId} -SkipAutomaticLocation -SetDefaultWindowTitle}"`, 'powershell'),
            startingDirectory: instance.installationPath,
          });
        }
        if (hasScript) {
          result.push({
            ...profile(`vs-cmd-${slug(instance.instanceId)}`, `Developer Command Prompt for VS ${suffix}`,
              `cmd.exe /k "${script}"`, 'cmd'),
            startingDirectory: instance.installationPath,
          });
        }
        return result;
      }));
      return groups.flat();
    })();

    const ssh = (async (): Promise<ProfileDefinition[]> => {
      const hosts = await loadSshConfigHosts(join(home, '.ssh', 'config'), { env });
      return hosts.map((host) => profile(`ssh-${slug(host)}`, `SSH ${host}`,
        `"${join(system32, 'OpenSSH', 'ssh.exe')}" ${quoteArg(host)}`, 'ssh'));
    })();

    const agents = (async (): Promise<ProfileDefinition[]> => {
      const [claude, codex, shells] = await Promise.all([where('claude'), where('codex'), powershells]);
      const shell = shells.find((item) => item.id === 'pwsh');
      return ([['claude', 'Claude Code', claude], ['codex', 'Codex', codex]] as const)
        .filter(([, , found]) => !!found.trim()).map(([id, name]) => ({
          ...profile(id, name, shell?.commandline ?? 'powershell.exe', shell?.shellKind ?? 'powershell'),
          startupCommand: id,
        }));
    })();

    const azure = (async (): Promise<ProfileDefinition[]> => {
      const shell = (await powershells).find((item) => item.id === 'pwsh');
      if (!shell) return [];
      // Do load the profile: Use-Az helpers live there. Never invoke the helpers themselves.
      const executable = shell.commandline.replace(/^"|"$/g, '');
      const output = await run(executable, ['-NoLogo', '-NonInteractive', '-Command',
        "Get-Command -Name 'Use-Az*' -CommandType Function,Alias -ErrorAction SilentlyContinue | ForEach-Object Name"], env, timeout);
      return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((name) => /^Use-Az[\w-]*$/i.test(name)))]
        .sort().map((name) => ({
          ...profile(slug(name), `Azure · ${name.slice(6) || 'Default'}`, shell.commandline, 'pwsh'),
          startupCommand: name,
        }));
    })();

    const results = await Promise.allSettled([powershells, windowsShells, git, wsl, visualStudio, ssh, agents, azure]);
    const profiles = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const used = new Set<string>();
    return profiles.map((item) => {
      let id = item.id;
      for (let index = 2; used.has(id); index += 1) id = `${item.id}-${index}`;
      used.add(id);
      return { ...item, id };
    });
  } catch {
    return [];
  }
}

/** Preserve saved edits. Discovery is additive; missing detected entries remain, hidden. */
export function mergeDetectedProfiles(existing: ProfileDefinition[], detected: ProfileDefinition[]): ProfileDefinition[] {
  const currentIds = new Set(detected.map((item) => item.id));
  const existingIds = new Set(existing.map((item) => item.id));
  const result = existing.map((item) => item.source === 'detected' && !currentIds.has(item.id)
    ? { ...item, hidden: true } : { ...item });
  for (const item of detected) {
    if (!existingIds.has(item.id)) {
      result.push({ ...item });
      existingIds.add(item.id);
    }
  }
  return result;
}
