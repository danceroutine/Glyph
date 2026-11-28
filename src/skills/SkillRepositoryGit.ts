import { repositoryEnvironment } from '#src/shell/TrustedHostExecutable.js';
import { captureRepositoryEnvironment } from './SkillRepositoryConfiguration.ts';
import { HostExecutionAuthority, type HostWorkspaceRoots } from '#src/shell/HostExecutionAuthority.js';
import type { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';
import { spawn } from 'node:child_process';
import { readdir, lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';

const maxStorage = 32 * 1024 * 1024;
async function storageBytes(root: string): Promise<number> {
  let bytes = 0,
    count = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (++count > 4096) throw new Error('Repository exceeds its object-store budget.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        bytes += info?.size ?? 0;
        if (bytes > maxStorage) throw new Error('Repository exceeds its 32 MiB download budget.');
      }
    }
  }
  await visit(root);
  return bytes;
}

/** Git transport, lazy object reads, and their helper processes share one deadline and storage budget. */
export class SkillRepositoryGit {
  private gitDirectory?: string;
  private localMirror?: string;
  private readonly mirrorDirectories = new Map<string, { revision: string; children: readonly string[] }>();
  private readonly mirrorConfigurations = new Map<string, string>();
  private environment: Promise<NodeJS.ProcessEnv> | undefined;
  private readonly authority: HostExecutionAuthority;
  constructor(
    private readonly cwd: string,
    private readonly signal: AbortSignal,
    workspace: HostWorkspaceRoots | HostProcessLeases,
    private readonly metadata: FilesystemMetadata & HostFilesystemAuthority,
  ) {
    this.authority = new HostExecutionAuthority(workspace, metadata);
    this.authority.admit(cwd);
  }
  async initialize(url: string): Promise<void> {
    const empty = {
      ...repositoryEnvironment(this.authority.workspaceRoots),
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    await this.execute(['init', '--bare', '--template=', 'source.git'], 1024 * 1024, empty);
    await this.execute(['--git-dir=source.git', 'remote', 'add', 'origin', url], 1024 * 1024, empty);
    this.gitDirectory = 'source.git';
    this.environment = undefined;
  }
  run(args: string[], maxOutput = 2 * 1024 * 1024): Promise<Buffer> {
    return this.execute(args, maxOutput);
  }
  private async execute(args: string[], maxOutput: number, initialization?: NodeJS.ProcessEnv): Promise<Buffer> {
    this.signal.throwIfAborted();
    await storageBytes(this.cwd);
    const gitArgs = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'fetch.unpackLimit=1',
      '-c',
      'remote.origin.promisor=true',
      '-c',
      'remote.origin.partialclonefilter=blob:none',
      ...args,
    ];
    const windows = process.platform === 'win32';
    // Transport sees the initialized repository and its selected remote when evaluating conditional includes.
    const env = initialization ?? (await (this.environment ??= this.captureEnvironment()));
    if (this.localMirror && !initialization) await this.checkLocalMirror(this.localMirror, env);
    const executable = this.authority.executable('git');
    const used = await storageBytes(this.cwd);
    // POSIX sh specifies 512-byte blocks. Limit each incoming pack before it can fill the disk between polls.
    const blocks = Math.max(1, Math.floor((maxStorage - used) / 512));
    const command = windows ? executable : this.authority.executable('sh');
    const argv = windows
      ? gitArgs
      : ['-c', 'ulimit -f "$1" || exit 1; shift; exec "$@"', 'glyph-git', String(blocks), executable, ...gitArgs];
    const result = await this.authority.run(this.signal, signal => this.spawn(command, argv, env, maxOutput, signal));
    this.signal.throwIfAborted();
    await storageBytes(this.cwd);
    return result;
  }

  private async captureEnvironment(): Promise<NodeJS.ProcessEnv> {
    return captureRepositoryEnvironment(
      this.authority.workspaceRoots,
      this.cwd,
      this.signal,
      this.metadata,
      this.gitDirectory,
      this.authority,
      async (path, environment) => {
        this.localMirror = await this.selectLocalMirror(path, environment);
        return this.localMirror;
      },
    );
  }

  /** Follow Git's local lookup order once. All subsequent fetches use the selected absolute Git directory. */
  private async selectLocalMirror(path: string, env: NodeJS.ProcessEnv): Promise<string> {
    const base = resolvePath(path);
    for (const location of [base, base + '.git']) {
      this.authority.admit(location);
      await this.authority.validate();
      for (const candidate of [join(location, '.git'), location]) {
        if (!(await lstat(candidate).catch(missingMirrorEntry))) continue;
        const directory = this.authority.admit(candidate);
        await this.authority.validate();
        if (!(await lstat(directory)).isDirectory())
          throw new Error('Local Git mirrors require a self-contained repository. Linked worktrees are unsupported.');
        if (!(await lstat(join(directory, 'HEAD')).catch(missingMirrorEntry))) continue;
        await this.checkLocalMirror(directory, env);
        // This read checks the repository format after all storage and config inputs have been admitted.
        await this.execute(['rev-parse', '--resolve-git-dir', directory], 64 * 1024, env);
        return directory;
      }
    }
    throw new Error('Local Git mirror does not contain a repository.');
  }

  /** Recheck the selected storage before every transport, including lazy object reads. */
  private async checkLocalMirror(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
    const markers = ['commondir', 'objects/info/alternates', 'objects/info/http-alternates'].map(name =>
      join(directory, name),
    );
    for (const input of [
      ...markers,
      ...[
        'HEAD',
        'config',
        'config.worktree',
        'packed-refs',
        'shallow',
        'info/grafts',
        'info/attributes',
        'refs',
        'objects',
        'reftable',
      ].map(name => join(directory, name)),
    ])
      this.authority.admit(input);
    await this.authority.validate();
    if (!(await lstat(join(directory, 'HEAD')).catch(missingMirrorEntry)))
      throw new Error('The selected Git mirror is no longer available. Retry the preview.');
    for (const marker of markers) {
      if (await lstat(marker).catch(missingMirrorEntry))
        throw new Error(
          'Local Git mirrors with a common directory or alternate object store require a local package import.',
        );
    }
    for (const name of ['objects', 'refs', 'reftable'])
      await this.checkMirrorTree(this.authority.admit(join(directory, name)), new Set());
    for (const name of ['config', 'config.worktree'])
      await this.checkMirrorConfiguration(this.authority.admit(join(directory, name)), env);
  }

  /** Object shards, packs and ref namespaces may themselves contain links. Inspect entries without
   * following links. Reuse directory listings across lazy blob reads while their native metadata is unchanged. */
  private async checkMirrorTree(path: string, ancestors: Set<string>): Promise<void> {
    this.signal.throwIfAborted();
    const info = await lstat(path, { bigint: true }).catch(missingMirrorEntry);
    if (!info) return;
    const identity = `${info.dev}:${info.ino}`;
    if (!info.isDirectory() || ancestors.has(identity))
      throw new Error('Local Git mirrors require ordinary object and reference directories.');
    const revision = `${identity}:${info.ctimeNs}:${info.mtimeNs}`;
    let listing = this.mirrorDirectories.get(path);
    if (listing?.revision !== revision) {
      const children: string[] = [];
      for await (const entry of await opendir(path)) {
        this.signal.throwIfAborted();
        if (entry.isDirectory()) children.push(join(path, entry.name));
        else if (entry.isFile()) this.authority.admit(join(path, entry.name));
        else throw new Error('Local Git mirrors require self-contained object and reference files.');
      }
      listing = { revision, children };
      this.mirrorDirectories.set(path, listing);
    }
    ancestors.add(identity);
    for (const child of listing.children) await this.checkMirrorTree(child, ancestors);
    ancestors.delete(identity);
  }

  /** The local upload-pack process reads its repository config and consults Git attributes when packing blobs.
   * Inspect the effective inputs before execution and on subsequent config revisions. */
  private async checkMirrorConfiguration(path: string, env: NodeJS.ProcessEnv): Promise<void> {
    const info = await lstat(path, { bigint: true }).catch(missingMirrorEntry);
    if (!info) return;
    const revision = `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}`;
    if (this.mirrorConfigurations.get(path) === revision) return;
    const configuration = await this.execute(
      ['config', '--no-includes', '--file', path, '--null', '--list'],
      1024 * 1024,
      env,
    );
    for (const record of new TextDecoder('utf-8', { fatal: true }).decode(configuration).split('\0')) {
      const key = record.split('\n', 1)[0]!;
      if (/^(?:include|includeif\..+)\.path$/isu.test(key))
        throw new Error('Local Git mirrors with configuration includes require a local package import.');
      if (key === 'core.worktree')
        throw new Error('Local Git mirrors with an explicit worktree require a local package import.');
      if (key === 'core.attributesfile') {
        const value = record.slice(key.length + 1);
        const file = value.startsWith('~/') ? join(env.HOME!, value.slice(2)) : value;
        if (!isAbsolute(file) || value.split(sep).includes('..'))
          throw new Error('Local Git mirror attributes require an absolute or home-relative path.');
        this.authority.admit(file);
      }
    }
    this.mirrorConfigurations.set(path, revision);
  }

  /** The process group owns credential and transport helpers. Release its lease after cancellation and pipe closure. */
  private spawn(
    command: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    maxOutput: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const windows = process.platform === 'win32';
    return new Promise((accept, reject) => {
      const child = spawn(command, argv, {
        cwd: this.cwd,
        env,
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0,
        errBytes = 0,
        failure: Error | undefined,
        inspecting: Promise<void> | undefined,
        terminating: Promise<void> | undefined;
      const stop = (reason: Error) => {
        if (failure) return;
        failure = reason;
        if (!child.pid) return;
        if (windows) {
          const kill = spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          terminating = new Promise<void>(resolve => {
            // Spawn failure also emits close, which handles a direct-child fallback.
            kill.once('error', () => {});
            kill.once('close', code => {
              if (code !== 0) child.kill('SIGKILL');
              resolve();
            });
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const abort = () => {
        stop(signal.reason instanceof Error ? signal.reason : new Error('Repository fetch cancelled.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const watch = setInterval(() => {
        inspecting ??= storageBytes(this.cwd)
          .then(
            () => {},
            (error: Error) => {
              stop(error);
            },
          )
          .finally(() => {
            inspecting = undefined;
          });
      }, 50);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutput) stop(new Error('Repository object exceeds its output budget.'));
        else out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes <= 64 * 1024) err.push(chunk);
        else stop(new Error('Repository diagnostics exceed their output budget.'));
      });
      child.once('error', error => {
        failure ??= error;
      });
      child.once('close', code => {
        clearInterval(watch);
        signal.removeEventListener('abort', abort);
        void Promise.all([inspecting, terminating]).then(() => {
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new Error(Buffer.concat(err).toString('utf8').trim() || 'Git repository access failed.'));
          else accept(Buffer.concat(out));
        }, reject);
      });
    });
  }
}

function missingMirrorEntry(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
  throw error;
}
