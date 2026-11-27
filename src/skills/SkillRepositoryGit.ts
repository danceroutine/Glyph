import { repositoryEnvironment } from '#src/shell/TrustedHostExecutable.js';
import { captureRepositoryEnvironment } from './SkillRepositoryConfiguration.ts';
import { HostExecutionAuthority, type HostWorkspaceRoots } from '#src/shell/HostExecutionAuthority.js';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';
import { spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

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
  private environment?: Promise<NodeJS.ProcessEnv>;
  private readonly authority: HostExecutionAuthority;
  constructor(
    private readonly cwd: string,
    private readonly signal: AbortSignal,
    workspaceRoots: HostWorkspaceRoots,
    private readonly metadata: FilesystemMetadata & HostFilesystemAuthority,
  ) {
    this.authority = new HostExecutionAuthority(workspaceRoots, metadata);
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
    const env =
      initialization ??
      (await (this.environment ??= captureRepositoryEnvironment(
        this.authority.workspaceRoots,
        this.cwd,
        this.signal,
        this.metadata,
        args.find(arg => arg.startsWith('--git-dir='))?.slice('--git-dir='.length),
        this.authority,
      )));
    const executable = this.authority.executable('git');
    const used = await storageBytes(this.cwd);
    // POSIX sh specifies 512-byte blocks. Limit each incoming pack before it can fill the disk between polls.
    const blocks = Math.max(1, Math.floor((maxStorage - used) / 512));
    const command = windows ? executable : this.authority.executable('sh');
    const argv = windows
      ? gitArgs
      : ['-c', 'ulimit -f "$1" || exit 1; shift; exec "$@"', 'glyph-git', String(blocks), executable, ...gitArgs];
    await this.authority.validate();
    const result = await new Promise<Buffer>((accept, reject) => {
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
        inspecting: Promise<void> | undefined;
      const stop = (reason: Error) => {
        if (failure) return;
        failure = reason;
        if (!child.pid) return;
        if (windows) {
          const kill = spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          kill.on('error', () => {
            child.kill('SIGKILL');
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
        stop(this.signal.reason instanceof Error ? this.signal.reason : new Error('Repository fetch cancelled.'));
      };
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
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
        this.signal.removeEventListener('abort', abort);
        void Promise.resolve(inspecting).then(() => {
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new Error(Buffer.concat(err).toString('utf8').trim() || 'Git repository access failed.'));
          else accept(Buffer.concat(out));
        }, reject);
      });
    });
    this.signal.throwIfAborted();
    await storageBytes(this.cwd);
    return result;
  }
}
