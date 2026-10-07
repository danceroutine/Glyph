import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ShellPermissionMode, type ShellPermissionPolicy } from './ShellPermissionPolicy.ts';
import type { ShellPermissionStore } from './ShellPermissionStore.ts';

const shellPermissionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    projectContextId: z.string().min(1),
    mode: z.enum(ShellPermissionMode),
    allowedCommands: z.array(z.string().min(1)),
  })
  .strict();

/** Atomic JSON storage for a project's explicit shell authorization policy. */
export class FileShellPermissionStore implements ShellPermissionStore {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'shell-permissions.json');
  }

  async load(projectContextId: string): Promise<ShellPermissionPolicy | undefined> {
    try {
      const policy = shellPermissionPolicySchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      if (policy.projectContextId !== projectContextId) {
        throw new Error('Shell permission policy belongs to a different project context.');
      }
      return policy;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not load shell permissions.', { cause: error });
    }
  }

  async save(policy: ShellPermissionPolicy): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(temporary, JSON.stringify(policy, null, 2), { flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      throw new Error('Could not persist shell permissions.', { cause: error });
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}
