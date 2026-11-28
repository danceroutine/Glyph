import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposal, type EditProposalRecord } from '#src/editing/proposals/EditProposal.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { ProposalReviewStore } from './ProposalReviewStore.ts';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';

interface ProposalReviewCheckpoint {
  readonly schemaVersion: 3;
  readonly workspaceIdentity: string;
  readonly proposals: readonly EditProposalRecord[];
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
    appliedText: z
      .object({
        state: z.enum(['applying', 'applied', 'reverting', 'reverted', 'kept']),
        before: snapshotSchema.nullable(),
        after: snapshotSchema.nullable(),
        revertTarget: snapshotSchema.nullable(),
      })
      .strict()
      .optional(),
    rejectionComment: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .transform(({ appliedText, ...item }) => ({ ...item, ...(appliedText ? { appliedText } : {}) }));

const fileEditPlanSchema = z
  .object({
    id: z.string().min(1),
    operation: z.enum(EditOperation),
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1),
    automatic: z
      .object({
        itemId: z.string().min(1),
        before: snapshotSchema.nullable(),
        state: z.enum(['applying', 'applied', 'reverting', 'reverted', 'kept']),
        appliedRevision: z.string().nullable(),
      })
      .strict()
      .optional(),
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
  .transform(({ automatic, ...file }) => ({
    ...file,
    ...(automatic ? { automatic } : {}),
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

function scopedCheckpointPath(directory: string, identity: string): string {
  return join(
    directory,
    'mutation-scopes',
    createHash('sha256').update(identity).digest('hex'),
    'active-proposal-review.json',
  );
}

async function readCheckpoint(path: string) {
  try {
    const checkpoint = checkpointSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!checkpoint.success) throw new Error('Unsupported proposal-review checkpoint schema.');
    return checkpoint.data;
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
}

type SavedProposal = z.output<typeof editProposalSchema>;
type Snapshot = z.output<typeof snapshotSchema>;

/** Keep reviewed bytes, object identities and operation IDs while translating the stored workspace routes. */
function restoreProposalPaths(proposal: SavedProposal, route: (path: string) => string): EditProposalRecord {
  const snapshot = <T extends Snapshot | null>(value: T): T =>
    value === null ? value : { ...value, path: route(value.path) };
  return {
    ...proposal,
    files: proposal.files.map(file => ({
      ...file,
      sourcePath: route(file.sourcePath),
      targetPath: route(file.targetPath),
      currentPath: route(file.currentPath),
      createdDirectories: file.createdDirectories.map(route),
      base: snapshot(file.base),
      proposed: snapshot(file.proposed),
      current: snapshot(file.current),
      ...(file.automatic && { automatic: { ...file.automatic, before: snapshot(file.automatic.before) } }),
      items: file.items.map(item => ({
        ...item,
        ...(item.appliedText && {
          appliedText: {
            ...item.appliedText,
            before: snapshot(item.appliedText.before),
            after: snapshot(item.appliedText.after),
            revertTarget: snapshot(item.appliedText.revertTarget),
          },
        }),
      })),
    })),
  };
}

/** Filesystem-backed, atomic checkpoint storage for active proposal reviews. */
export class FileProposalReviewStore implements ProposalReviewStore {
  private readonly path: string;
  private readonly previousPath?: string;
  private readonly legacyPath: string | undefined;

  constructor(
    directory: string,
    private readonly options: {
      readonly mutationScope?: string;
      readonly previousScope?: { readonly identity: string; readonly restorePath: (path: string) => string };
    } = {},
  ) {
    const legacy = join(directory, 'active-proposal-review.json');
    if (options.mutationScope !== undefined) {
      // A saved workspace keeps its container id when folders change. Reviews
      // instead belong to the exact roots against which their paths were planned.
      this.path = scopedCheckpointPath(directory, options.mutationScope);
      if (options.previousScope) this.previousPath = scopedCheckpointPath(directory, options.previousScope.identity);
      this.legacyPath = legacy;
    } else {
      this.path = legacy;
    }
  }

  async load(workspaceIdentity: string): Promise<EditProposal[]> {
    try {
      this.assertScope(workspaceIdentity);
      let checkpoint = await readCheckpoint(this.path);
      let expected = workspaceIdentity;
      const importing = checkpoint === undefined;
      const previous = this.options.previousScope;
      if (!checkpoint && this.previousPath && previous) {
        checkpoint = await readCheckpoint(this.previousPath);
        expected = previous.identity;
      }
      if (!checkpoint && this.legacyPath) {
        checkpoint = await readCheckpoint(this.legacyPath);
        if (
          !checkpoint ||
          (checkpoint.workspaceIdentity !== workspaceIdentity && checkpoint.workspaceIdentity !== previous?.identity)
        )
          return [];
        expected = checkpoint.workspaceIdentity;
      }
      if (!checkpoint) return [];
      if (checkpoint.workspaceIdentity !== expected)
        throw new Error('Proposal-review checkpoint belongs to a different workspace.');
      const proposals = checkpoint.proposals.map(record =>
        EditProposal.from(
          previous && expected === previous.identity ? restoreProposalPaths(record, previous.restorePath) : record,
        ),
      );
      if (importing && !(await this.write(proposals, workspaceIdentity, true)))
        return await this.load(workspaceIdentity);
      return proposals;
    } catch (error) {
      throw new EditError(
        EditFailureReason.PERSISTENCE,
        'Could not load the active proposal reviews.',
        {},
        { cause: error },
      );
    }
  }

  async save(proposals: readonly EditProposal[], workspaceIdentity: string): Promise<void> {
    await this.write(proposals, workspaceIdentity, false);
  }

  async clear(): Promise<void> {
    // An empty scoped checkpoint is authoritative. Deleting it would import
    // the retained legacy backup again and resurrect already settled reviews.
    if (this.options.mutationScope !== undefined) return this.save([], this.options.mutationScope);
    try {
      await unlink(this.path);
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') {
        throw new EditError(
          EditFailureReason.PERSISTENCE,
          'Could not clear the settled proposal reviews.',
          {},
          { cause: error },
        );
      }
    }
  }

  private async write(
    proposals: readonly EditProposal[],
    workspaceIdentity: string,
    createOnly: boolean,
  ): Promise<boolean> {
    this.assertScope(workspaceIdentity);
    if (proposals.length === 0 && this.options.mutationScope === undefined) {
      await this.clear();
      return true;
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const checkpoint: ProposalReviewCheckpoint = {
      schemaVersion: 3,
      workspaceIdentity,
      proposals: proposals.map(proposal => proposal.toRecord()),
    };
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2), { flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      if (createOnly) {
        try {
          // A concurrent save or clear of the current scope wins over the historical checkpoint.
          await link(temporary, this.path);
        } catch (error) {
          if (errorCodeOf(error) === 'EEXIST') return false;
          throw error;
        }
      } else await rename(temporary, this.path);
      return true;
    } catch (error) {
      throw new EditError(
        EditFailureReason.PERSISTENCE,
        'Could not persist the active proposal reviews.',
        {},
        { cause: error },
      );
    } finally {
      await unlink(temporary).catch(error => {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
      });
    }
  }

  private assertScope(workspaceIdentity: string): void {
    if (this.options.mutationScope !== undefined && this.options.mutationScope !== workspaceIdentity) {
      throw new EditError(EditFailureReason.PERSISTENCE, 'The review store is bound to a different mutation scope.');
    }
  }
}
