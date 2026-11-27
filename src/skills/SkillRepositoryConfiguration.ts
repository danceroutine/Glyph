import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
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
): Promise<string> {
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
  authority.admit(path);
  await access(path, constants.X_OK);
  if (!(await stat(path)).isFile()) throw new Error('A credential helper must be an executable file.');
  // This is generated from one admitted executable, never from a configuration shell fragment.
  return "!exec '" + path.replaceAll("'", "'\\''") + "'";
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
): Promise<NodeJS.ProcessEnv> {
  const environment = repositoryEnvironment(authority.workspaceRoots);
  const executable = authority.executable('git');
  authority.admit(cwd);
  const readGit = (args: string[], maxBuffer: number, input?: Buffer) =>
    authority.run(
      signal,
      processSignal =>
        new Promise<Buffer>((accept, reject) => {
          let failure: Error | null;
          let output: Buffer;
          const child = execFile(
            executable,
            args,
            { cwd, env: environment, signal: processSignal, timeout: 5000, maxBuffer, encoding: 'buffer' },
            (error, bytes) => {
              failure ??= error;
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
  environment.GIT_EXEC_PATH = executionDirectory;
  const config = async (args: string[], input?: Buffer) => {
    const bytes = await readGit(
      [...(gitDirectory && input === undefined ? ['--git-dir=' + gitDirectory] : []), 'config', '--null', ...args],
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
  let bytes = 0;
  for (let index = 0; index < records.length; index += 3) {
    const scope = records[index]!;
    const origin = records[index + 1]!;
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
    const value = records[index + 2]!;
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
    if (parsed.value && option === 'proxy' && (key.startsWith('http.') || key.startsWith('remote.')))
      assertNetworkProxy(parsed.value);
    if (key.startsWith('http.') && httpPaths.has(option) && parsed.value) {
      entries.push({ key: parsed.key, value: httpPathValue(option, parsed.value, environment.HOME, authority) });
      continue;
    }
    if (key.startsWith('credential.') && key.endsWith('.helper') && parsed.value) {
      entries.push({ key: parsed.key, value: await pinCredentialHelper(parsed.value, executionDirectory, authority) });
      continue;
    }
    if (!(key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path')))) entries.push(parsed);
  }
  const text = entries
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
  const ssh = await authority.optionalExecutable('ssh');
  await authority.validate();
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: path,
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // SSH config may itself contain executable ProxyCommand/LocalCommand directives.
    // Use the admitted system client with its default keys/agent and no command-bearing config.
    ...(ssh
      ? {
          GIT_ALLOW_PROTOCOL: 'https:ssh:file',
          GIT_SSH_COMMAND:
            "'" + ssh.replaceAll("'", "'\\''") + "' -F " + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
        }
      : {}),
  };
}
