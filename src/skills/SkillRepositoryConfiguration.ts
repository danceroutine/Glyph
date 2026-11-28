import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, open, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { assertNetworkProxy, repositoryEnvironment } from '#src/shell/TrustedHostExecutable.js';
import { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';
import { readHostFile } from './readHostFile.ts';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

interface Entry {
  readonly key: string;
  readonly value?: string;
}

function entry(text: string): Entry {
  const split = text.indexOf('\n');
  return split < 0 ? { key: text } : { key: text.slice(0, split), value: text.slice(split + 1) };
}

function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function quote(text: string): string {
  return (
    '"' +
    text.replaceAll(
      /[\\"\n\t\b]/gu,
      character => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\b': '\\b' })[character]!,
    ) +
    '"'
  );
}

/** Git and libcurl open these paths themselves after Git has parsed the configuration. */
const httpPaths = new Set([
  'cookiefile',
  'pinnedpubkey',
  'proxysslcainfo',
  'proxysslcert',
  'proxysslkey',
  'sslcainfo',
  'sslcert',
  'sslkey',
]);

// The private repository consumes these scalar settings. File and command options are handled separately.
const httpOptions = new Set([
  'curloptresolve',
  'delegation',
  'emptyauth',
  'extraheader',
  'followredirects',
  'lowspeedlimit',
  'lowspeedtime',
  'maxrequests',
  'minsessions',
  'noproxy',
  'postbuffer',
  'proactiveauth',
  'proxy',
  'proxyauthmethod',
  'proxysslcertpasswordprotected',
  'savecookies',
  'schannelcheckrevoke',
  'schannelusesslcainfo',
  'sslbackend',
  'sslcertpasswordprotected',
  'sslcerttype',
  'sslkeytype',
  'sslcipherlist',
  'ssltry',
  'sslverify',
  'sslversion',
  'useragent',
  'version',
]);

function transportSetting(key: string, option: string): boolean {
  if (key.startsWith('http.')) return httpPaths.has(option) || httpOptions.has(option);
  if (key.startsWith('credential.'))
    return ['helper', 'username', 'usehttppath', 'interactive', 'sanitizeprompt', 'protectprotocol'].includes(option);
  if (key.startsWith('url.')) return option === 'insteadof' || option === 'pushinsteadof';
  return [
    'remote.origin.url',
    'remote.origin.proxy',
    'remote.origin.proxyauthmethod',
    'user.name',
    'user.email',
    'fetch.prune',
    'fetch.fsckobjects',
    'transfer.fsckobjects',
    'protocol.version',
    'uploadpack.allowfilter',
    'uploadpack.allowanysha1inwant',
    'uploadpack.allowreachablesha1inwant',
    'uploadpack.allowtipsha1inwant',
    'uploadpack.hiderefs',
    'transfer.hiderefs',
  ].includes(key);
}

function httpPathValue(
  key: string,
  value: string,
  home: string | undefined,
  authority: HostExecutionAuthority,
): string {
  // libcurl also accepts a semicolon-separated list of public-key digests instead of a filename.
  if (key === 'pinnedpubkey' && value.split(';').every(pin => /^sha256\/\/[A-Za-z0-9+/]{43}=$/u.test(pin)))
    return value;
  const path = home && value.startsWith('~/') ? join(home, value.slice(2)) : value;
  if (!isAbsolute(path))
    throw new Error('Git HTTP file settings require one absolute path or a path in the user home directory.');
  return authority.admit(path);
}

async function pinCredentialHelper(
  value: string,
  directory: string,
  authority: HostExecutionAuthority,
): Promise<{ command: string; store: boolean }> {
  if (value.startsWith('!') || (!isAbsolute(value) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)))
    throw new Error(
      'Repository preview supports credential helper names or absolute executables without arguments. Inline shell helpers require importing a local package instead.',
    );
  let path = value;
  if (!isAbsolute(path)) {
    path = join(directory, `git-credential-${value}`);
  }
  // Git installations can dispatch multicall helpers through their symlink's basename.
  // Retain that invocation while tracking and rechecking both logical and physical authority.
  const physical = authority.admit(path);
  await access(path, constants.X_OK);
  if (!(await stat(path)).isFile()) throw new Error('A credential helper must be an executable file.');
  // This is generated from one admitted executable, never from a configuration shell fragment.
  const command = '!exec ' + shellArgument(path);
  return { command, store: [path, physical].some(file => /^git-credential-store(?:\.exe)?$/iu.test(basename(file))) };
}

/**
 * Capture effective Git settings once, including active transitive includes.
 * Every value must also occur in a descriptor-verified copy of its trusted source.
 * Transport reads a private flattened snapshot, so later edits and conditional
 * includes cannot introduce configuration between preview subprocesses.
 */
export async function captureRepositoryEnvironment(
  roots: readonly string[],
  cwd: string,
  signal: AbortSignal,
  metadata: FilesystemMetadata & HostFilesystemAuthority,
  gitDirectory?: string,
  authority = new HostExecutionAuthority(roots, metadata),
  selectLocalMirror?: (path: string, environment: NodeJS.ProcessEnv) => Promise<string>,
): Promise<NodeJS.ProcessEnv> {
  const environment = repositoryEnvironment(authority.workspaceRoots);
  const home = environment.HOME ?? environment.USERPROFILE ?? userInfo().homedir;
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    HOME: home,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const executable = authority.executable('git');
  authority.admit(cwd);
  const readGit = (
    args: string[],
    maxBuffer: number,
    input?: Buffer,
    env: NodeJS.ProcessEnv = isolated,
    allowNoMatch = false,
  ) =>
    authority.run(
      signal,
      processSignal =>
        new Promise<Buffer>((accept, reject) => {
          let failure: Error | null;
          let output: Buffer;
          const child = execFile(
            executable,
            args,
            { cwd, env, signal: processSignal, timeout: 5000, maxBuffer, encoding: 'buffer' },
            (error, bytes, diagnostics) => {
              const noMatch = allowNoMatch && error?.code === 1 && !diagnostics?.length;
              failure ??= noMatch ? null : error;
              output = bytes;
            },
          );
          // Node can invoke execFile's callback on abort before the child has exited.
          // Keep its host inputs leased until the process and its pipes have closed.
          child.once('close', () => {
            if (failure) reject(new Error(failure.message, { cause: failure }));
            else accept(output);
          });
          child.stdin!.once('error', error => {
            failure ??= error;
          });
          child.stdin!.end(input);
        }),
    );
  const executionDirectory = (await readGit(['--exec-path'], 16 * 1024)).toString('utf8').trim();
  authority.admit(executionDirectory);
  for (const helper of ['git-remote-https', 'git-upload-pack'])
    authority.admit(join(executionDirectory, helper + (process.platform === 'win32' ? '.exe' : '')));
  isolated.GIT_EXEC_PATH = executionDirectory;
  const xdg = environment.XDG_CONFIG_HOME ?? join(home, '.config');
  const global = process.env.GIT_CONFIG_GLOBAL;
  const sourcesToInclude =
    global === nullDevice
      ? []
      : global && isAbsolute(global)
        ? [global]
        : [join(xdg, 'git/config'), join(home, '.gitconfig')];
  // An explicit --system query reads the installation's own file as data while startup system config stays off.
  // Git returns status 1 for an absent or empty file. Reuse the installation's spelling for conditional includes.
  if (/^(?:false|no|off|[+-]?0+)?$/iu.test(environment.GIT_CONFIG_NOSYSTEM ?? '')) {
    const locations = await readGit(
      ['config', '--system', '--null', '--no-includes', '--show-origin', '--name-only', '--get-regexp', '.'],
      1024 * 1024,
      undefined,
      isolated,
      true,
    );
    if (locations.length > 0) {
      const first = new TextDecoder('utf-8', { fatal: true }).decode(locations).split('\0')[0]!;
      if (!first.startsWith('file:')) throw new Error('Git system configuration must have a file origin.');
      sourcesToInclude.unshift(resolve(cwd, first.slice(5)));
    }
  }
  for (const path of sourcesToInclude) authority.admit(path);
  const includes = sourcesToInclude.flatMap(path => ['-c', 'include.path=' + path]);
  const config = async (args: string[], input?: Buffer) => {
    const bytes = await readGit(
      [
        ...(gitDirectory && input === undefined ? ['--git-dir=' + gitDirectory] : []),
        ...(input === undefined ? includes : []),
        'config',
        '--null',
        ...args,
      ],
      1024 * 1024,
      input,
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  };
  // This command parses settings only. It does not contact a remote or run a configured helper.
  const output = await config(['--show-scope', '--show-origin', '--includes', '--list']);
  if (output && !output.endsWith('\0')) throw new Error('Git returned invalid configuration origins.');
  const records = output.split('\0');
  records.pop();
  if (records.length % 3 !== 0) throw new Error('Git returned invalid configuration origins.');
  const sources = new Map<string, Set<string>>();
  const entries: Entry[] = [];
  let credentialStore = false;
  let bytes = 0;
  for (let index = 0; index < records.length; index += 3) {
    const scope = records[index]!;
    const origin = records[index + 1]!;
    const value = records[index + 2]!;
    if (
      scope === 'command' &&
      origin === 'command line:' &&
      sourcesToInclude.some(path => value === 'include.path\n' + path)
    )
      continue;
    if (!origin.startsWith('file:')) throw new Error('Git configuration must have a trusted file origin.');
    let values = sources.get(origin);
    if (!values) {
      const path = authority.admit(resolve(cwd, origin.slice(5)));
      await authority.validate();
      const snapshot = await readHostFile(path, 1024 * 1024 - bytes);
      await authority.validate();
      bytes += snapshot.bytes.length;
      values = new Set(
        (await config(['--no-includes', '--file', '-', '--list'], snapshot.bytes)).split('\0').slice(0, -1),
      );
      sources.set(origin, values);
    }
    if (!values.has(value)) throw new Error('Git configuration changed during capture. Retry the preview.');
    // Git continues to read the host-created local store. Copying its multivalues would duplicate the remote.
    if (scope === 'local') continue;
    const parsed = entry(value);
    const key = parsed.key.toLowerCase();
    if (
      /(?:^core\.(?:sshcommand|gitproxy|askpass|alternaterefscommand)$|^uploadpack\.packobjectshook$|^remote\..*\.(?:uploadpack|receivepack|vcs)$)/u.test(
        key,
      )
    )
      throw new Error(
        'Repository preview cannot run command-valued Git transport settings. Use a named credential helper or import a local package.',
      );
    const option = key.slice(key.lastIndexOf('.') + 1);
    if (parsed.value && key.startsWith('http.') && option === 'sslcapath')
      throw new Error(
        'Git HTTP CA directories can reference additional files. Configure an sslCAInfo certificate bundle or import a local package.',
      );
    if (!transportSetting(key, option)) continue;
    if (parsed.value && option === 'proxy') assertNetworkProxy(parsed.value);
    if (key.startsWith('http.') && httpPaths.has(option) && parsed.value) {
      entries.push({ key: parsed.key, value: httpPathValue(option, parsed.value, home, authority) });
      continue;
    }
    if (key.startsWith('credential.') && key.endsWith('.helper') && parsed.value) {
      const helper = await pinCredentialHelper(parsed.value, executionDirectory, authority);
      credentialStore ||= helper.store;
      entries.push({ key: parsed.key, value: helper.command });
      continue;
    }
    if (key === 'credential.helper' && !parsed.value) credentialStore = false;
    entries.push(parsed);
  }
  const writeConfig = async (entriesToWrite: readonly Entry[]) => {
    const text = entriesToWrite
      .map(({ key, value }) => {
        const first = key.indexOf('.'),
          last = key.lastIndexOf('.');
        const section = key.slice(0, first);
        // Git subsection names escape only quotes and backslashes. Tabs and backspaces remain literal.
        const subsection = first === last ? '' : ' "' + key.slice(first + 1, last).replaceAll(/[\\"]/gu, '\\$&') + '"';
        return `[${section}${subsection}]\n\t${key.slice(last + 1)}${value === undefined ? '' : ' = ' + quote(value)}\n`;
      })
      .join('');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Git configuration exceeds its capture budget.');
    const path = join(cwd, `glyph-host-${randomUUID()}.gitconfig`);
    const handle = await open(path, 'wx', 0o600);
    try {
      await metadata.inspect(handle, 'access');
      await handle.writeFile(text);
      await handle.chmod(0o400);
    } finally {
      await handle.close();
    }
    authority.admit(path);
    return path;
  };
  const env: NodeJS.ProcessEnv = {
    ...isolated,
    GIT_CONFIG_GLOBAL: await writeConfig(entries),
    GIT_CONFIG_SYSTEM: nullDevice,
  };
  await authority.validate();
  if (!gitDirectory || !selectLocalMirror) return env;
  const repo = '--git-dir=' + gitDirectory;
  const effective = await readGit([repo, 'remote', 'get-url', 'origin'], 64 * 1024, undefined, env);
  const remote = new TextDecoder('utf-8', { fatal: true }).decode(effective).replace(/\n$/u, '');
  const mirror = localMirrorPath(remote);
  if (mirror) {
    authority.admit(join(xdg, 'git/attributes'));
    const directory = await selectLocalMirror(mirror, env);
    const pinned = pathToFileURL(directory).href;
    localMirrorPath(pinned);
    // The user's rules have selected the mirror. The private remote now uses its exact Git directory,
    // including for promisor fetches. Keep other captured settings and disable further URL rewrites.
    env.GIT_CONFIG_GLOBAL = await writeConfig(
      entries.filter(setting => {
        const key = setting.key.toLowerCase();
        return (
          key !== 'remote.origin.url' &&
          !(key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof')))
        );
      }),
    );
    env.GIT_ALLOW_PROTOCOL = 'file';
    await readGit([repo, 'config', '--local', '--replace-all', 'remote.origin.url', pinned], 64 * 1024, undefined, env);
    // Local transport removes client Git directory/index variables when it starts the server.
    // Run its pack generator in bare mode, including for ordinary checkouts, with a private empty index.
    const uploadPack =
      'GIT_IMPLICIT_WORK_TREE=0 GIT_INDEX_FILE=' +
      shellArgument(join(cwd, 'glyph-pack.index')) +
      ' ' +
      shellArgument(executable) +
      ' -c core.bare=true upload-pack --strict';
    await readGit([repo, 'config', '--local', 'remote.origin.uploadpack', uploadPack], 64 * 1024, undefined, env);
  } else if (/^(?:(?:ssh|git\+ssh|ssh\+git):\/\/|[^/]+:(?!\/\/))/iu.test(remote)) {
    env.GIT_SSH_COMMAND = await repositorySshCommand(env, process.env.SSH_AUTH_SOCK, authority);
    env.GIT_ALLOW_PROTOCOL = 'ssh';
  } else if (/^https:\/\//iu.test(remote)) {
    authority.admit(join(home, '.netrc'));
    if (process.platform === 'win32') authority.admit(join(home, '_netrc'));
    if (credentialStore) {
      for (const path of [join(home, '.git-credentials'), join(xdg, 'git/credentials')]) {
        const physical = authority.admit(path);
        // Git updates the selected credential file under a lock alongside its physical target.
        authority.admit(path + '.lock');
        authority.admit(physical + '.lock');
      }
    }
    await authority.validate();
  } else {
    throw new Error('Repository preview supports HTTPS, SSH and local Git mirrors.');
  }
  return env;
}

/** OpenSSH receives explicit authentication paths only for an effective SSH remote.
 * The executable, keys, certificates, host-key databases and agent socket share its process lease. */
async function repositorySshCommand(
  env: NodeJS.ProcessEnv,
  agentSocket: string | undefined,
  authority: HostExecutionAuthority,
): Promise<string> {
  const ssh = authority.executable('ssh');
  const home = userInfo().homedir;
  const directory = join(home, '.ssh');
  const admitFile = (path: string) => {
    // OpenSSH expands tokens and environment references in path-valued options.
    if (path.includes('${') || /[\r\n\0]/u.test(path))
      throw new Error('SSH authentication paths must be representable as literal OpenSSH file names.');
    authority.admit(path);
    return '"' + path.replaceAll('%', '%%').replaceAll(/[\\"]/gu, '\\$&') + '"';
  };
  const args = [
    ssh,
    '-F',
    env.GIT_CONFIG_SYSTEM!,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
  ];
  for (const name of ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_dsa', 'id_xmss']) {
    const path = join(directory, name);
    authority.admit(path + '.pub');
    authority.admit(path + '-cert.pub');
    args.push('-o', 'IdentityFile=' + admitFile(path));
  }
  const knownHosts = [join(directory, 'known_hosts'), join(directory, 'known_hosts2')].map(path => admitFile(path));
  const system = process.platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh') : '/etc/ssh';
  const globalHosts = [join(system, 'ssh_known_hosts'), join(system, 'ssh_known_hosts2')].map(path => admitFile(path));
  args.push('-o', 'UserKnownHostsFile=' + knownHosts.join(' '), '-o', 'GlobalKnownHostsFile=' + globalHosts.join(' '));
  if (agentSocket) {
    if (!isAbsolute(agentSocket)) throw new Error('SSH authentication agents require an absolute socket path.');
    env.SSH_AUTH_SOCK = authority.admitSocket(agentSocket);
    args.push('-o', 'IdentityAgent=SSH_AUTH_SOCK');
  } else {
    args.push('-o', 'IdentityAgent=none');
  }
  await authority.validate();
  return args.map(value => shellArgument(value)).join(' ');
}

/** Git accepts local paths and file URLs as fetch transports. Require an unambiguous absolute mirror location. */
function localMirrorPath(remote: string): string | undefined {
  const invalid = new Error('Local Git mirrors require an absolute repository path or local file URL.');
  if (!remote || /[\u0000-\u001F\u007F]/u.test(remote)) throw invalid;
  let path = remote;
  if (remote.startsWith('file://')) {
    // Git decodes URL escapes before interpreting the path. Reject forms whose URL and filesystem
    // interpretations differ, including home-directory expansion and traversing beyond a linked parent.
    if (!/^file:\/\/(?:localhost)?\//u.test(remote) || /[?#\\]/u.test(remote)) throw invalid;
    const decoded = decodeURIComponent(remote.slice(remote.indexOf('/', 'file://'.length)));
    if (decoded.startsWith('/~') || decoded.split('/').includes('..') || decoded.includes('\0')) throw invalid;
    path = fileURLToPath(remote);
  } else if (!isAbsolute(path)) {
    // All remaining network transports are still subject to Git's explicit protocol allowlist.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(remote) || /^[^/]+:/u.test(remote)) return undefined;
    throw invalid;
  }
  if (path.replaceAll(sep, '/').split('/').includes('..')) throw invalid;
  return path;
}
