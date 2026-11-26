import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { WorkspaceDirectoryMutations } from './WorkspaceDirectoryMutations.ts';

const replySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
type Operation =
  | { operation: 'ensure_directory' | 'remove_tree' | 'create_stage'; relative: string; mode?: number }
  | {
      operation: 'stage_package';
      relative: string;
      files: { path: string; mode: number; content: string }[];
      directories: { path: string; mode: number }[];
    }
  | { operation: 'rename_exclusive'; sourceRelative: string; targetRelative: string };

/** Pins the host-authorized physical directory; the native helper traverses and mutates relative to that identity. */
export class NativeWorkspaceMutations implements WorkspaceDirectoryMutations {
  private constructor(
    private readonly executable: string,
    private readonly root: string,
    private readonly rootIdentity: { readonly device: string; readonly inode: string },
  ) {}
  static async open(executable: string, physicalRoot: string): Promise<NativeWorkspaceMutations> {
    if ((await realpath(physicalRoot)) !== physicalRoot)
      throw new Error('Workspace mutations require a physical root.');
    const handle = await open(physicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      return new NativeWorkspaceMutations(await realpath(executable), physicalRoot, {
        device: String(stat.dev),
        inode: String(stat.ino),
      });
    } finally {
      await handle.close();
    }
  }
  ensureDirectory(relative: string, mode?: number): Promise<void> {
    return this.run({ operation: 'ensure_directory', relative, ...(mode === undefined ? {} : { mode }) });
  }
  createStage(relative: string): Promise<void> {
    return this.run({ operation: 'create_stage', relative });
  }
  stagePackage(
    relative: string,
    files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mode: number }>,
    directories: ReadonlyMap<string, number>,
  ): Promise<void> {
    return this.run({
      operation: 'stage_package',
      relative,
      files: [...files].map(([path, file]) => ({
        path,
        mode: file.mode,
        content: Buffer.from(file.bytes).toString('base64'),
      })),
      directories: [...directories].map(([path, mode]) => ({ path, mode })),
    });
  }
  renameExclusive(sourceRelative: string, targetRelative: string): Promise<void> {
    return this.run({ operation: 'rename_exclusive', sourceRelative, targetRelative });
  }
  removeTree(relative: string): Promise<void> {
    return this.run({ operation: 'remove_tree', relative });
  }
  private async run(operation: Operation): Promise<void> {
    const request = JSON.stringify({ ...operation, root: this.root, rootIdentity: this.rootIdentity });
    const maxBytes = operation.operation === 'stage_package' ? 24 * 1024 * 1024 : 32 * 1024;
    if (Buffer.byteLength(request) > maxBytes)
      throw new Error('Workspace mutation request exceeds ' + maxBytes / 1024 + ' KiB.');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.executable,
        [],
        { env: {}, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 },
        (error, output) => {
          if (error) reject(new Error('Workspace mutation helper failed.', { cause: error }));
          else resolve(output);
        },
      );
      child.stdin!.on('error', reject).end(request);
    });
    const reply = replySchema.parse(JSON.parse(stdout));
    if (!reply.ok) throw Object.assign(new Error(reply.message), { code: reply.code });
  }
}
