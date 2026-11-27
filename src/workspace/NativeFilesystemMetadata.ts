import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import type { WorkspacePathAccess } from './WorkspacePathAccess.ts';
import type { FilesystemMetadata } from './FilesystemMetadata.ts';

import type { HostFilesystemAuthority } from './HostFilesystemAuthority.ts';

/** The native inspector receives the caller's already-open inode on standard input. */
export class NativeFilesystemMetadata implements FilesystemMetadata, HostFilesystemAuthority, WorkspacePathAccess {
  constructor(private readonly executable: string) {}

  async assertWorkspacePath(
    path: string,
    privatePaths: readonly string[],
    options?: { readonly handle?: FileHandle },
  ): Promise<void> {
    const inode = await options?.handle?.stat({ bigint: true });
    const child = spawn(this.executable, ['--assert-workspace-path'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      env: {},
    });
    const input = new Promise<void>((resolve, reject) => {
      child.stdin.once('error', reject);
      child.stdin.end(
        JSON.stringify({
          path,
          privatePaths,
          identity: inode && [String(inode.dev), String(inode.ino)],
        }),
        resolve,
      );
    });
    let acknowledgement = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      acknowledgement = (acknowledgement + chunk).slice(0, 10);
    });
    await Promise.all([input, once(child, 'close')]);
    if (child.exitCode !== 0 || acknowledgement !== 'verified\n')
      throw new Error('That path is excluded from project access or changed during inspection.');
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

  async assertHostPaths(paths: readonly string[], workspaceRoots: readonly string[]): Promise<void> {
    const child = spawn(this.executable, ['--assert-host-paths'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      env: {},
    });
    const failure = 'Could not establish host filesystem authority outside every workspace.';
    // A helper that refuses its request can close the input before the whole frame is written.
    const input = new Promise<void>((resolve, reject) => {
      child.stdin.once('error', reject);
      child.stdin.end(JSON.stringify({ paths, workspaceRoots }), resolve);
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
