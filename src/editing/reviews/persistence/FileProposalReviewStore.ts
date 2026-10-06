import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EditError } from '../../errors/EditError.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import type { EditProposal } from '../../proposals/EditProposal.ts';
import type { ProposalReviewStore } from './ProposalReviewStore.ts';

interface ProposalReviewCheckpoint {
  readonly schemaVersion: 2;
  readonly proposals: readonly EditProposal[];
}

/** Filesystem-backed, atomic checkpoint storage for active proposal reviews. */
export class FileProposalReviewStore implements ProposalReviewStore {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'active-proposal-review.json');
  }

  async load(): Promise<EditProposal[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (isLegacyProposal(value)) return [value];
      if (!isCheckpoint(value)) throw new Error('Unsupported proposal-review checkpoint schema.');
      return [...value.proposals];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new EditError(
        EditFailureReason.PERSISTENCE,
        'Could not load the active proposal reviews.',
        {},
        { cause: error },
      );
    }
  }

  async save(proposals: readonly EditProposal[]): Promise<void> {
    if (proposals.length === 0) return this.clear();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const checkpoint: ProposalReviewCheckpoint = { schemaVersion: 2, proposals };
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2), { flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      throw new EditError(
        EditFailureReason.PERSISTENCE,
        'Could not persist the active proposal reviews.',
        {},
        { cause: error },
      );
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new EditError(
          EditFailureReason.PERSISTENCE,
          'Could not clear the settled proposal reviews.',
          {},
          { cause: error },
        );
      }
    }
  }
}

function isLegacyProposal(value: unknown): value is EditProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<EditProposal>;
  return proposal.schemaVersion === 1 && typeof proposal.id === 'string' && Array.isArray(proposal.files);
}

function isCheckpoint(value: unknown): value is ProposalReviewCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<ProposalReviewCheckpoint>;
  return (
    checkpoint.schemaVersion === 2 &&
    Array.isArray(checkpoint.proposals) &&
    checkpoint.proposals.every(isLegacyProposal)
  );
}
