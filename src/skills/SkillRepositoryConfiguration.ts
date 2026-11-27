import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { outsideWorkspace, repositoryEnvironment, trustedHostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';

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
    text.replace(
      /[\\"\n\t\b]/gu,
      character => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\b': '\\b' })[character]!,
    ) +
    '"'
  );
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
  metadata: FilesystemMetadata,
  gitDirectory?: string,
): Promise<NodeJS.ProcessEnv> {
  const environment = repositoryEnvironment(roots);
  const executable = trustedHostExecutable('git', roots);
  const config = (args: string[], input?: Buffer) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        executable,
        [...(gitDirectory && input === undefined ? ['--git-dir=' + gitDirectory] : []), 'config', '--null', ...args],
        {
          cwd,
          env: environment,
          signal,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
      child.stdin!.end(input);
    });
  // This command parses settings only. It does not contact a remote or run a configured helper.
  const output = await config(['--show-origin', '--includes', '--list']);
  if (output && !output.endsWith('\0')) throw new Error('Git returned invalid configuration origins.');
  const records = output.split('\0');
  records.pop();
  if (records.length % 2 !== 0) throw new Error('Git returned invalid configuration origins.');
  const sources = new Map<string, Set<string>>();
  const entries: Entry[] = [];
  let bytes = 0;
  for (let index = 0; index < records.length; index += 2) {
    const origin = records[index]!;
    if (!origin.startsWith('file:')) throw new Error('Git configuration must have a trusted file origin.');
    let values = sources.get(origin);
    if (!values) {
      const path = outsideWorkspace(resolve(cwd, origin.slice(5)), roots);
      const store = new FileSystemWorkspaceTextStore(dirname(path), { caseSensitive: true, allowPrivateRoot: true });
      const snapshot = await store.readBytes(basename(path), { maxBytes: 1024 * 1024 - bytes });
      bytes += snapshot.bytes.length;
      values = new Set(
        (await config(['--no-includes', '--file', '-', '--list'], snapshot.bytes)).split('\0').slice(0, -1),
      );
      sources.set(origin, values);
    }
    const value = records[index + 1]!;
    if (!values.has(value)) throw new Error('Git configuration changed during capture. Retry the preview.');
    const parsed = entry(value);
    if (!/^include(?:if\..*)?\.path$/iu.test(parsed.key)) entries.push(parsed);
  }
  const text = entries
    .map(({ key, value }) => {
      const first = key.indexOf('.'),
        last = key.lastIndexOf('.');
      const section = key.slice(0, first);
      const subsection = first === last ? '' : ' ' + quote(key.slice(first + 1, last));
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
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: path,
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
