import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import type { SourceOriginReader } from './PinnedSourceAuthority.ts';
import type { FileHandle } from 'node:fs/promises';
import type { WorkspacePathAccess } from './WorkspacePathAccess.ts';
import type { FilesystemMetadata } from './FilesystemMetadata.ts';

/** The native inspector receives the caller's already-open inode on standard input. */
export class NativeFilesystemMetadata implements FilesystemMetadata, WorkspacePathAccess, SourceOriginReader {
  constructor(private readonly executable: string) {}

  /** Inspect all source routes in a single native request, using the caller's operation reservations. */
  async sourceOrigins(paths: readonly string[], privatePaths: readonly string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (paths.length === 0) return [];
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.executable,
        ['--source-origins'],
        { env: {}, signal, timeout: 30_000, maxBuffer: paths.length * 160 },
        (error, stdout) => error ? reject(error) : resolve(stdout),
      );
      child.stdin!.on('error', reject);
      child.stdin!.end(JSON.stringify({ paths, privatePaths }));
    });
    return z.array(z.object({ origin: z.string().regex(/^[a-f0-9]{64}$/u), identity: z.string().regex(/^\d+:\d+$/u) }).strict()).length(paths.length).parse(JSON.parse(output));
  }

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
    let acknowledgement = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      acknowledgement = (acknowledgement + chunk).slice(0, 10);
    });
    await once(child, 'close');
    if (child.exitCode !== 0 || acknowledgement !== 'verified\n')
      throw new Error(
        'Could not verify filesystem metadata. The object may have unsupported extended data or access controls.',
      );
  }
}
