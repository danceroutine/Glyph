import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EditError } from './EditError.ts';
import { EditFailureReason } from './EditFailureReason.ts';
import type { EditProposal } from './EditProposal.ts';
import type { EditSessionStore } from './EditSessionStore.ts';

export class FileEditSessionStore implements EditSessionStore {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'active-edit-session.json');
  }

  async load(): Promise<EditProposal | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as EditProposal;
      if (value.schemaVersion !== 1 || !Array.isArray(value.files)) throw new Error('Unsupported edit-session checkpoint schema.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new EditError(EditFailureReason.PERSISTENCE, 'Could not load the active edit session.', {}, { cause: error });
    }
  }

  async save(proposal: EditProposal): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(temporary, JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      throw new EditError(EditFailureReason.PERSISTENCE, 'Could not persist the active edit session.', {}, { cause: error });
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  async clear(): Promise<void> {
    try { await unlink(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new EditError(EditFailureReason.PERSISTENCE, 'Could not clear the settled edit session.', {}, { cause: error });
      }
    }
  }
}
