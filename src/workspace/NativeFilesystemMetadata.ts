import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import type { FilesystemMetadata } from './FilesystemMetadata.ts';

/** The native inspector receives the caller's already-open inode on standard input. */
export class NativeFilesystemMetadata implements FilesystemMetadata {
  constructor(private readonly executable: string) {}

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
