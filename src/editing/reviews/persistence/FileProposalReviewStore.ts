import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { ProposalReviewStore } from './ProposalReviewStore.ts';

interface ProposalReviewCheckpoint {
  readonly schemaVersion: 3;
  readonly workspaceIdentity: string;
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
    rejectionComment: z.string().min(1).max(4000).optional(),
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
    origin: z
      .object({
        chatId: z.string().min(1),
        accountProvider: z.string().min(1),
        accountId: z.string().min(1),
      })
      .strict()
      .optional(),
    acknowledgedResultIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .transform(({ origin, acknowledgedResultIds, ...proposal }) => ({
    ...proposal,
    ...(origin ? { origin } : {}),
    acknowledgedResultIds: acknowledgedResultIds ?? [],
  }));

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(3),
    workspaceIdentity: z.string().min(1),
    proposals: z.array(editProposalSchema),
  })
  .strict();

/** Filesystem-backed, atomic checkpoint storage for active proposal reviews. */
export class FileProposalReviewStore implements ProposalReviewStore {
  private readonly path: string;
  private readonly legacyPath: string | undefined;

  constructor(
    directory: string,
    private readonly options: { readonly mutationScope?: string } = {},
  ) {
    const legacy = join(directory, 'active-proposal-review.json');
    if (options.mutationScope !== undefined) {
      // A saved workspace keeps its container id when folders change. Reviews
      // instead belong to the exact roots against which their paths were planned.
      const scope = createHash('sha256').update(options.mutationScope).digest('hex');
      this.path = join(directory, 'mutation-scopes', scope, 'active-proposal-review.json');
      this.legacyPath = legacy;
    } else {
      this.path = legacy;
    }
  }

  async load(workspaceIdentity: string): Promise<EditProposal[]> {
    try {
      this.assertScope(workspaceIdentity);
      let text: string;
      let importingLegacy = false;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !this.legacyPath) throw error;
        text = await readFile(this.legacyPath, 'utf8');
        importingLegacy = true;
      }
      const value: unknown = JSON.parse(text);
      const checkpoint = checkpointSchema.safeParse(value);
      if (!checkpoint.success) throw new Error('Unsupported proposal-review checkpoint schema.');
      if (checkpoint.data.workspaceIdentity !== workspaceIdentity) {
        // Preserve the old scope's checkpoint; never reinterpret its paths in
        // the new roots or make an unrelated scope unavailable because it exists.
        if (importingLegacy) return [];
        throw new Error('Proposal-review checkpoint belongs to a different workspace.');
      }
      if (importingLegacy) await this.save(checkpoint.data.proposals, workspaceIdentity);
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

  async save(proposals: readonly EditProposal[], workspaceIdentity: string): Promise<void> {
    this.assertScope(workspaceIdentity);
    if (proposals.length === 0 && this.options.mutationScope === undefined) return this.clear();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const checkpoint: ProposalReviewCheckpoint = { schemaVersion: 3, workspaceIdentity, proposals };
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
    // An empty scoped checkpoint is authoritative. Deleting it would import
    // the retained legacy backup again and resurrect already settled reviews.
    if (this.options.mutationScope !== undefined) return this.save([], this.options.mutationScope);
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

  private assertScope(workspaceIdentity: string): void {
    if (this.options.mutationScope !== undefined && this.options.mutationScope !== workspaceIdentity) {
      throw new EditError(EditFailureReason.PERSISTENCE, 'The review store is bound to a different mutation scope.');
    }
  }
}
