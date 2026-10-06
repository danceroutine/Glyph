import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { EditError } from '../../errors/EditError.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { EditOperation } from '../../proposals/EditOperation.ts';
import type { EditProposal } from '../../proposals/EditProposal.ts';
import { EditApplicabilityState } from '../EditApplicabilityState.ts';
import { EditDecisionState } from '../EditDecisionState.ts';
import { EditReviewItemKind } from '../EditReviewItemKind.ts';
import type { ProposalReviewStore } from './ProposalReviewStore.ts';

interface ProposalReviewCheckpoint {
  readonly schemaVersion: 2;
  readonly proposals: readonly EditProposal[];
}

const snapshotSchema = z
  .object({
    path: z.string().min(1),
    text: z.string(),
    byteOrderMark: z.boolean(),
    revision: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    identity: z.string().min(1).optional(),
  })
  .strict()
  .transform(snapshot => ({ ...snapshot, identity: snapshot.identity ?? `legacy:${snapshot.path}` }));

const reviewItemSchema = z
  .object({
    id: z.string().min(1),
    fileId: z.string().min(1),
    kind: z.enum(EditReviewItemKind),
    sourceStart: z.number().int().nonnegative(),
    sourceEnd: z.number().int().nonnegative(),
    removedText: z.string(),
    insertedText: z.string(),
    decision: z.enum(EditDecisionState),
  })
  .strict();

const fileEditPlanSchema = z
  .object({
    id: z.string().min(1),
    operation: z.enum(EditOperation),
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1),
    base: snapshotSchema.nullable(),
    proposed: snapshotSchema,
    items: z.array(reviewItemSchema),
    current: snapshotSchema.nullable().optional(),
    applyingItemId: z.string().min(1).nullable().optional(),
    createdDirectories: z.array(z.string()).optional(),
    applicability: z.enum(EditApplicabilityState),
    currentPath: z.string().min(1),
    currentRevision: z.string().min(1).nullable(),
  })
  .strict()
  .transform(file => ({
    ...file,
    current: file.current === undefined ? file.base : file.current,
    applyingItemId: file.applyingItemId ?? null,
    createdDirectories: file.createdDirectories ?? [],
  }));

const editProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    source: z.enum(['patch', 'structured']),
    createdAt: z.string().min(1),
    files: z.array(fileEditPlanSchema),
  })
  .strict();

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(2),
    proposals: z.array(editProposalSchema),
  })
  .strict();

/** Filesystem-backed, atomic checkpoint storage for active proposal reviews. */
export class FileProposalReviewStore implements ProposalReviewStore {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, 'active-proposal-review.json');
  }

  async load(): Promise<EditProposal[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      const legacy = editProposalSchema.safeParse(value);
      if (legacy.success) return [legacy.data];
      const checkpoint = checkpointSchema.safeParse(value);
      if (!checkpoint.success) throw new Error('Unsupported proposal-review checkpoint schema.');
      return [...checkpoint.data.proposals];
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
