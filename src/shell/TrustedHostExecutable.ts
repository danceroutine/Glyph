import { resolveAvailableIdentity } from './ShellRuntimePathPolicy.ts';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

export type HostExecutable = 'git' | 'sh' | 'ssh' | 'node' | 'python3';

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export function outsideWorkspace(path: string, roots: readonly string[]): string {
  const physical = resolveAvailableIdentity(path);
  if (roots.some(root => contains(resolveAvailableIdentity(root), physical))) {
    throw new Error('Host tools, configuration and temporary storage must reside outside writable workspaces.');
  }
  return physical;
}

/** Resolves the selected installation before it is displayed or passed to a child process. */
export function trustedHostExecutable(name: HostExecutable, workspaceRoots: readonly string[]): string {
  const roots = workspaceRoots.map(root => resolveAvailableIdentity(root));
  const candidates =
    process.platform === 'win32'
      ? name === 'git'
        ? ['C:\\Program Files\\Git\\cmd\\git.exe']
        : name === 'ssh'
          ? ['C:\\Windows\\System32\\OpenSSH\\ssh.exe']
          : []
      : [
          ...(name === 'node' && basename(process.execPath) === 'node' ? [process.execPath] : []),
          ...(name === 'sh' ? ['/bin/sh'] : []),
          ...['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].map(directory => `${directory}/${name}`),
        ];
  for (const candidate of candidates) {
    try {
      const path = realpathSync.native(candidate);
      if (roots.some(root => contains(root, path)) || !statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // An optional installation can be absent.
    }
  }
  throw new Error(`A trusted ${name} installation outside writable workspaces is required.`);
}

/** libcurl interprets a SOCKS proxy with a trailing path as a local Unix-domain socket. */
export function assertNetworkProxy(proxy: string): void {
  if (/^socks[\w+.-]*:\/\/[^/]*\//iu.test(proxy.trim()))
    throw new Error(
      'Repository preview supports network proxy endpoints. Import a local package when using a SOCKS socket path.',
    );
}

/** Trusted Git configuration may define credential helpers and mirrors. Its location must be outside project authority. */
export function repositoryEnvironment(roots: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH:
      process.platform === 'win32'
        ? 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd'
        : '/usr/bin:/bin:/usr/sbin:/sbin',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https',
  };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'LANG',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'SystemRoot',
  ]) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'].includes(key)) {
      if (!isAbsolute(value)) continue;
      environment[key] = outsideWorkspace(value, roots);
    } else {
      if (['HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'http_proxy'].includes(key)) assertNetworkProxy(value);
      environment[key] = value;
    }
  }
  if (!environment.GIT_CONFIG_GLOBAL && environment.HOME) {
    outsideWorkspace(join(environment.HOME, '.gitconfig'), roots);
    outsideWorkspace(join(environment.XDG_CONFIG_HOME ?? join(environment.HOME, '.config'), 'git/config'), roots);
  }
  return environment;
}
