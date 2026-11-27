import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { access, constants, stat } from 'node:fs/promises';
import { repositoryEnvironment } from '#src/shell/TrustedHostExecutable.js';
import { SkillRepositoryAuthority } from './SkillRepositoryAuthority.ts';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
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

async function pinCredentialHelper(
  value: string,
  git: string,
  authority: SkillRepositoryAuthority,
  signal: AbortSignal,
): Promise<string> {
  if (value.startsWith('!') || (!isAbsolute(value) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)))
    throw new Error(
      'Repository preview supports credential helper names or absolute executables without arguments. Inline shell helpers require importing a local package instead.',
    );
  let path = value;
  if (!isAbsolute(path)) {
    await authority.validate();
    const directory = await new Promise<string>((accept, reject) => {
      execFile(
        git,
        ['--exec-path'],
        {
          signal,
          timeout: 5000,
          maxBuffer: 16 * 1024,
          encoding: 'utf8',
          env: repositoryEnvironment(authority.workspaceRoots),
        },
        (error, output) => {
          if (error) reject(new Error(error.message, { cause: error }));
          else accept(output.trim());
        },
      );
    });
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
  authority = new SkillRepositoryAuthority(roots, metadata),
): Promise<NodeJS.ProcessEnv> {
  const environment = repositoryEnvironment(authority.workspaceRoots);
  const executable = authority.executable('git');
  authority.admit(cwd);
  const config = async (args: string[], input?: Buffer) => {
    await authority.validate();
    return new Promise<Buffer>((accept, reject) => {
      const child = execFile(
        executable,
        [...(gitDirectory && input === undefined ? ['--git-dir=' + gitDirectory] : []), 'config', '--null', ...args],
        {
          cwd,
          env: environment,
          signal,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          encoding: 'buffer',
        },
        (error, output) => {
          if (error) reject(new Error(error.message, { cause: error }));
          else accept(output);
        },
      );
      child.stdin!.end(input);
    }).then(bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
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
      const store = new FileSystemWorkspaceTextStore(dirname(path), { caseSensitive: true, allowPrivateRoot: true });
      const snapshot = await store.readBytes(basename(path), { maxBytes: 1024 * 1024 - bytes });
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
    if (/(?:^core\.(?:sshcommand|gitproxy|askpass)$|^remote\..*\.(?:uploadpack|receivepack|proxy)$)/u.test(key))
      throw new Error(
        'Repository preview cannot run command-valued Git transport settings. Use a named credential helper or import a local package.',
      );
    if (key.startsWith('credential.') && key.endsWith('.helper') && parsed.value) {
      entries.push({ key: parsed.key, value: await pinCredentialHelper(parsed.value, executable, authority, signal) });
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
  const ssh = authority.executable('ssh');
  await authority.validate();
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: path,
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // SSH config may itself contain executable ProxyCommand/LocalCommand directives.
    // Use the admitted system client with its default keys/agent and no command-bearing config.
    GIT_SSH_COMMAND: "'" + ssh.replaceAll("'", "'\\''") + "' -F /dev/null",
  };
}
