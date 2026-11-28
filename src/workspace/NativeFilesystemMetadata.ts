import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import type { SourceOriginReader } from './PinnedSourceAuthority.ts';
import type { FileHandle } from 'node:fs/promises';
import type { WorkspacePathAccess } from './WorkspacePathAccess.ts';
import type { FilesystemMetadata } from './FilesystemMetadata.ts';

import type { HostFilesystemAuthority } from './HostFilesystemAuthority.ts';

const sourceOrigin = z
  .object({ origin: z.string().regex(/^[a-f0-9]{64}$/u), identity: z.string().regex(/^\d+:\d+$/u) })
  .strict();

/**
 * Bridges host operations to the native physical identity and metadata checks.
 * Workspace path admission can bind a route to the caller's open handle. File
 * metadata inspection passes that handle directly to the inspector. Both
 * results describe the operation in progress and expire when its target changes.
 */
export class NativeFilesystemMetadata
  implements FilesystemMetadata, HostFilesystemAuthority, WorkspacePathAccess, SourceOriginReader
{
  constructor(private readonly executable: string) {}

  /** Inspect all source routes in a single native request, using the caller's operation reservations. */
  async sourceOrigins(
    paths: readonly string[],
    privatePaths: readonly string[],
    signal?: AbortSignal,
    directories = false,
  ) {
    return z
      .array(sourceOrigin)
      .length(paths.length)
      .parse(await this.inspectSources(paths, privatePaths, signal, directories ? { directories } : {}));
  }

  /** Enroll readable catalog files together, preserving the positions of unavailable siblings. */
  async availableSourceOrigins(paths: readonly string[], privatePaths: readonly string[], signal?: AbortSignal) {
    const output = await this.inspectSources(paths, privatePaths, signal, { allowUnavailable: true });
    return z.array(sourceOrigin.nullable()).length(paths.length).parse(output);
  }

  /** Verify that an approved source was actually unlinked. A renamed or inaccessible directory fails this check. */
  async assertUnlinkedDirectory(descriptor: number): Promise<void> {
    const child = spawn(this.executable, ['--assert-unlinked-directory'], {
      stdio: [descriptor, 'pipe', 'ignore'],
      timeout: 5000,
      env: {},
    });
    await this.acknowledge(child, 'The imported source directory moved. Preview the source again.');
  }

  async assertWorkspacePath(
    path: string,
    privatePaths: readonly string[],
    options?: { readonly handle?: FileHandle; readonly managedDirectories?: readonly string[] },
  ): Promise<void> {
    const inode = await options?.handle?.stat({ bigint: true });
    await this.sendPathRequest(
      '--assert-workspace-path',
      {
        path,
        privatePaths,
        managedDirectories: options?.managedDirectories,
        identity: inode && [String(inode.dev), String(inode.ino)],
      },
      'That path is excluded from project access or changed during inspection.',
    );
  }

  async inspect(handle: FileHandle, purpose: 'access' | 'replaceable'): Promise<void> {
    const child = spawn(this.executable, [`--assert-${purpose}-metadata`], {
      stdio: [handle.fd, 'pipe', 'ignore'],
      timeout: 5000,
      env: {},
    });
    await this.acknowledge(
      child,
      'Could not verify filesystem metadata. The object may have unsupported extended data or access controls.',
    );
  }

  async assertHostPaths(
    paths: readonly string[],
    workspaceRoots: readonly string[],
    sockets?: readonly string[],
  ): Promise<void> {
    await this.sendPathRequest(
      '--assert-host-paths',
      { paths, workspaceRoots, ...(sockets?.length && { sockets }) },
      'Could not establish host filesystem authority outside every workspace.',
    );
  }

  private async inspectSources(
    paths: readonly string[],
    privatePaths: readonly string[],
    signal: AbortSignal | undefined,
    options: { readonly directories?: boolean; readonly allowUnavailable?: boolean },
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (paths.length === 0) return [];
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.executable,
        ['--source-origins'],
        { env: {}, signal, timeout: 30_000, maxBuffer: paths.length * 160 },
        (error, stdout) => {
          if (error) reject(new Error('The instruction source inspection failed.', { cause: error }));
          else resolve(stdout);
        },
      );
      child.stdin!.on('error', reject);
      child.stdin!.end(JSON.stringify({ paths, privatePaths, ...options }));
    });
    return JSON.parse(output);
  }

  private async sendPathRequest(flag: string, payload: object, failure: string): Promise<void> {
    const child = spawn(this.executable, [flag], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, env: {} });
    // A helper that refuses its request can close the input before the whole frame is written.
    const input = new Promise<void>((resolve, reject) => {
      child.stdin.once('error', reject);
      child.stdin.end(JSON.stringify(payload), resolve);
    });
    await Promise.all([input, this.acknowledge(child, failure)]);
  }

  private async acknowledge(child: ChildProcess, failure: string): Promise<void> {
    let acknowledgement = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      acknowledgement = (acknowledgement + chunk).slice(0, 10);
    });
    await once(child, 'close');
    if (child.exitCode !== 0 || acknowledgement !== 'verified\n') throw new Error(failure);
  }
}
