import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '../../../observability/NullLogger.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import type { WorkspaceMutationOptions } from '../../../workspace/WorkspaceMutationOptions.ts';
import type { WorkspaceTextSnapshot } from '../../../workspace/WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from '../../../workspace/WorkspaceTextStore.ts';
import type { EditingConfiguration } from '../../configuration/EditingConfiguration.ts';
import { JsDiffTextDiffer } from '../../documents/JsDiffTextDiffer.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { EditOperation } from '../../proposals/EditOperation.ts';
import type { EditProposal } from '../../proposals/EditProposal.ts';
import { EditProposalService } from '../../proposals/EditProposalService.ts';
import { EditDecisionState } from '../EditDecisionState.ts';
import { ProposalReviewManager } from '../ProposalReviewManager.ts';
import { FileProposalReviewStore } from '../persistence/FileProposalReviewStore.ts';

const directories: string[] = [];
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576,
  maxChangedBytes: 1_048_576,
  maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 8,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe(ProposalReviewManager, () => {
  describe('concurrent decisions', () => {
    it('performs one mutation when duplicate accepts and an opposing reject arrive together', async () => {
      const { manager, service, workspace } = await fixture({ 'file.txt': 'base\n' });
      const proposal = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'base', replacement: 'accepted' },
      ]);
      await manager.stage(proposal);
      const item = proposal.files[0]!.items[0]!;

      const results = await Promise.allSettled([
        manager.accept(item.id),
        manager.accept(item.id),
        manager.reject(item.id),
      ]);

      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({ status: 'fulfilled' });
      expect(results[2]).toMatchObject({
        status: 'rejected',
        reason: { reason: EditFailureReason.DECISION_CONFLICT },
      });
      expect(workspace.mutationAttempts).toEqual(['replace:file.txt']);
      expect(await workspace.read('file.txt')).toMatchObject({ text: 'accepted\n' });
      expect(manager.activeReviews).toEqual([]);
    });

    it('lets the first queued rejection win without performing a workspace mutation', async () => {
      const { manager, service, workspace } = await fixture({ 'file.txt': 'base\n' });
      const proposal = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'base', replacement: 'accepted' },
      ]);
      await manager.stage(proposal);
      const item = proposal.files[0]!.items[0]!;

      const results = await Promise.allSettled([manager.reject(item.id), manager.accept(item.id)]);

      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { reason: EditFailureReason.DECISION_CONFLICT },
      });
      expect(workspace.mutationAttempts).toEqual([]);
      expect(await workspace.read('file.txt')).toMatchObject({ text: 'base\n' });
      expect(manager.activeReviews).toEqual([]);
    });

    it('serializes non-monotonic mixed decisions while a mutation is suspended', async () => {
      const { manager, service, workspace } = await fixture({
        'file.txt': 'zero\nkeep-a\none\nkeep-b\ntwo\n',
      });
      const proposal = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'zero', replacement: 'ZERO' },
        { line: 2, expected: 'one', replacement: 'ONE' },
        { line: 4, expected: 'two', replacement: 'TWO' },
      ]);
      await manager.stage(proposal);
      const [zero, one, two] = proposal.files[0]!.items;
      const barrier = workspace.blockNextReplace();
      const resolutionOrder: string[] = [];

      const acceptTwo = manager.accept(two!.id).then(() => {
        resolutionOrder.push('accept-two');
      });
      await barrier.entered;
      const acceptZero = manager.accept(zero!.id).then(() => {
        resolutionOrder.push('accept-zero');
      });
      const rejectOne = manager.reject(one!.id).then(() => {
        resolutionOrder.push('reject-one');
      });

      expect(proposal.files[0]!.items.map(item => item.decision)).toEqual([
        EditDecisionState.PENDING,
        EditDecisionState.PENDING,
        EditDecisionState.ACCEPTED,
      ]);
      expect(workspace.mutationAttempts).toEqual(['replace:file.txt']);

      barrier.release();
      await Promise.all([acceptTwo, acceptZero, rejectOne]);

      expect(await workspace.read('file.txt')).toMatchObject({ text: 'ZERO\nkeep-a\none\nkeep-b\nTWO\n' });
      expect(workspace.mutationAttempts).toEqual(['replace:file.txt', 'replace:file.txt']);
      expect(resolutionOrder).toEqual(['accept-two', 'accept-zero', 'reject-one']);
      expect(manager.activeReviews).toEqual([]);
    });

    it('honors invocation order across reviews rather than forcing review arrival order', async () => {
      const { manager, service, workspace } = await fixture({ 'file.txt': 'first\nmiddle\nlast\n' });
      const firstReview = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'first', replacement: 'FIRST' },
      ]);
      const secondReview = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(firstReview);
      await manager.stage(secondReview);

      await Promise.all([
        manager.acceptInReview(secondReview.id, secondReview.files[0]!.items[0]!.id),
        manager.acceptInReview(firstReview.id, firstReview.files[0]!.items[0]!.id),
      ]);

      expect(await workspace.read('file.txt')).toMatchObject({ text: 'FIRST\nmiddle\nLAST\n' });
      expect(workspace.mutationAttempts).toEqual(['replace:file.txt', 'replace:file.txt']);
      expect(manager.activeReviews).toEqual([]);
    });

    it('continues the decision queue after a collaborator wins a revision race', async () => {
      const { root, manager, service, workspace } = await fixture({
        'file.txt': 'first\nhuman\nlast\n',
      });
      const proposal = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'first', replacement: 'FIRST' },
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      const [first, last] = proposal.files[0]!.items;
      const barrier = workspace.blockNextReplace();

      const acceptFirst = manager.accept(first!.id);
      await barrier.entered;
      const acceptLast = manager.accept(last!.id);
      await writeFile(join(root, 'file.txt'), 'first\nhuman-expanded\nlast\n');
      barrier.release();

      await expect(acceptFirst).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      await expect(acceptLast).resolves.toBeUndefined();
      expect(await workspace.read('file.txt')).toMatchObject({ text: 'first\nhuman-expanded\nLAST\n' });
      expect(first!.decision).toBe(EditDecisionState.PENDING);
      expect(last!.decision).toBe(EditDecisionState.ACCEPTED);

      await manager.accept(first!.id);

      expect(await workspace.read('file.txt')).toMatchObject({ text: 'FIRST\nhuman-expanded\nLAST\n' });
      expect(manager.activeReviews).toEqual([]);
    });
  });

  describe(ProposalReviewManager.prototype.acceptAll, () => {
    it('serializes a rejection ahead of accept-all and accepts only the remaining work', async () => {
      const { manager, service, workspace } = await fixture({
        'file.txt': 'first\nmiddle\nlast\n',
      });
      const proposal = await proposeLineChanges(service, workspace, 'file.txt', [
        { line: 0, expected: 'first', replacement: 'FIRST' },
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      const [first, last] = proposal.files[0]!.items;

      await Promise.all([manager.reject(last!.id), manager.acceptAll()]);

      expect(await workspace.read('file.txt')).toMatchObject({ text: 'FIRST\nmiddle\nlast\n' });
      expect(first!.decision).toBe(EditDecisionState.ACCEPTED);
      expect(last!.decision).toBe(EditDecisionState.REJECTED);
      expect(workspace.mutationAttempts).toEqual(['replace:file.txt']);
      expect(manager.activeReviews).toEqual([]);
    });

    it('performs zero mutations when a collaborator writes while preflight is reading later files', async () => {
      const { root, manager, service, workspace } = await fixture({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const proposal = await proposeWholeFileChanges(service, workspace, [
        { path: 'a.txt', content: 'A\n' },
        { path: 'b.txt', content: 'B\n' },
      ]);
      await manager.stage(proposal);
      const barrier = workspace.blockNextReadOptional('b.txt');

      const acceptance = manager.acceptAll();
      await barrier.entered;
      await writeFile(join(root, 'b.txt'), 'human\n');
      barrier.release();

      await expect(acceptance).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect(workspace.mutationAttempts).toEqual([]);
      expect(await workspace.read('a.txt')).toMatchObject({ text: 'a\n' });
      expect(await workspace.read('b.txt')).toMatchObject({ text: 'human\n' });
      expect(allDecisions(proposal)).toEqual([EditDecisionState.PENDING, EditDecisionState.PENDING]);

      await writeFile(join(root, 'b.txt'), 'b\n');
      await manager.acceptAll();

      expect(await workspace.read('a.txt')).toMatchObject({ text: 'A\n' });
      expect(await workspace.read('b.txt')).toMatchObject({ text: 'B\n' });
      expect(manager.activeReviews).toEqual([]);
    });

    it('durably retains earlier writes when a collaborator races the execution after preflight', async () => {
      const { root, manager, service, workspace } = await fixture({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const proposal = await proposeWholeFileChanges(service, workspace, [
        { path: 'a.txt', content: 'A\n' },
        { path: 'b.txt', content: 'B\n' },
      ]);
      await manager.stage(proposal);
      const barrier = workspace.blockNextReplace();

      const acceptance = manager.acceptAll();
      await barrier.entered;
      await writeFile(join(root, 'b.txt'), 'human\n');
      barrier.release();

      await expect(acceptance).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect(await workspace.read('a.txt')).toMatchObject({ text: 'A\n' });
      expect(await workspace.read('b.txt')).toMatchObject({ text: 'human\n' });
      expect(allDecisions(proposal)).toEqual([EditDecisionState.ACCEPTED, EditDecisionState.PENDING]);
      expect(manager.activeReviews).toEqual([proposal]);

      const recovered = new ProposalReviewManager(
        workspace,
        new FileProposalReviewStore(join(root, '.state')),
        new NullLogger(),
        8,
      );
      await recovered.initialize();
      expect(allDecisions(recovered.activeReviews[0]!)).toEqual([
        EditDecisionState.ACCEPTED,
        EditDecisionState.PENDING,
      ]);

      await writeFile(join(root, 'b.txt'), 'b\n');
      await recovered.acceptAll();

      expect(await workspace.read('a.txt')).toMatchObject({ text: 'A\n' });
      expect(await workspace.read('b.txt')).toMatchObject({ text: 'B\n' });
      expect(recovered.activeReviews).toEqual([]);
    });
  });

  describe(ProposalReviewManager.prototype.stage, () => {
    it('serializes concurrent staging and enforces capacity without losing arrival order', async () => {
      const { manager, service } = await fixture({}, 2);
      const proposals = await Promise.all([
        proposeCreation(service, 'first.txt', 'first'),
        proposeCreation(service, 'second.txt', 'second'),
        proposeCreation(service, 'third.txt', 'third'),
      ]);

      const results = await Promise.allSettled(proposals.map(proposal => manager.stage(proposal)));

      expect(results.slice(0, 2)).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(results[2]).toMatchObject({
        status: 'rejected',
        reason: { reason: EditFailureReason.ACTIVE_REVIEW_LIMIT },
      });
      expect(manager.activeReviews.map(review => review.id)).toEqual(
        proposals.slice(0, 2).map(proposal => proposal.id),
      );
    });
  });
});

class ControllableWorkspaceTextStore implements WorkspaceTextStore {
  readonly mutationAttempts: string[] = [];
  private replaceBarrier: Barrier | undefined;
  private readBarrier: { readonly path: string; readonly barrier: Barrier } | undefined;

  constructor(private readonly delegate: FileSystemWorkspaceTextStore) {}

  get root(): string {
    return this.delegate.root;
  }

  get caseSensitive(): boolean {
    return this.delegate.caseSensitive;
  }

  get mutationConsistency() {
    return this.delegate.mutationConsistency;
  }

  blockNextReplace(): Barrier {
    const barrier = createBarrier();
    this.replaceBarrier = barrier;
    return barrier;
  }

  blockNextReadOptional(path: string): Barrier {
    const barrier = createBarrier();
    this.readBarrier = { path, barrier };
    return barrier;
  }

  list(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }> {
    return this.delegate.list(maxFiles, globPattern, targetDirectory);
  }

  normalizePath(path: string): string {
    return this.delegate.normalizePath(path);
  }

  read(path: string): Promise<WorkspaceTextSnapshot> {
    return this.delegate.read(path);
  }

  async readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined> {
    const pending = this.readBarrier;
    if (pending?.path === path) {
      this.readBarrier = undefined;
      pending.barrier.arrive();
      await pending.barrier.released;
    }
    return this.delegate.readOptional(path);
  }

  async create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    mode?: number,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationAttempts.push(`create:${path}`);
    void options;
    return this.delegate.create(path, text, byteOrderMark, mode);
  }

  async replace(
    path: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationAttempts.push(`replace:${path}`);
    const barrier = this.replaceBarrier;
    if (barrier) {
      this.replaceBarrier = undefined;
      barrier.arrive();
      await barrier.released;
    }
    void options;
    return this.delegate.replace(path, expectedRevision, text, byteOrderMark);
  }

  async rename(
    source: string,
    target: string,
    expectedRevision: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationAttempts.push(`rename:${source}:${target}`);
    void options;
    return this.delegate.rename(source, target, expectedRevision);
  }

  async delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void> {
    this.mutationAttempts.push(`delete:${path}`);
    void options;
    return this.delegate.delete(path, expectedRevision);
  }
}

interface Barrier {
  readonly entered: Promise<void>;
  readonly released: Promise<void>;
  arrive(): void;
  release(): void;
}

function createBarrier(): Barrier {
  let arrive = (): void => {};
  let release = (): void => {};
  const entered = new Promise<void>(resolve => {
    arrive = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return { entered, released, arrive, release };
}

async function fixture(files: Readonly<Record<string, string>>, maxActiveReviews = 8) {
  const root = await mkdtemp(join(tmpdir(), 'proposal-concurrency-root-'));
  const state = join(root, '.state');
  directories.push(root);
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const workspace = new ControllableWorkspaceTextStore(new FileSystemWorkspaceTextStore(root));
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const manager = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(state),
    new NullLogger(),
    maxActiveReviews,
  );
  return { root, state, workspace, service, manager };
}

async function proposeLineChanges(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  path: string,
  changes: readonly {
    readonly line: number;
    readonly expected: string;
    readonly replacement: string;
  }[],
): Promise<EditProposal> {
  const base = await workspace.read(path);
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.UPDATE,
        path,
        new_path: null,
        base_revision: base.revision,
        content: null,
        byte_order_mark: null,
        edits: changes.map(({ line, expected, replacement }) => ({
          range: { start: { line, character: 0 }, end: { line, character: expected.length } },
          expected_text: expected,
          replacement_text: replacement,
        })),
      },
    ],
  });
}

async function proposeWholeFileChanges(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  changes: readonly { readonly path: string; readonly content: string }[],
): Promise<EditProposal> {
  return service.proposeStructured({
    files: await Promise.all(
      changes.map(async ({ path, content }) => ({
        operation: EditOperation.UPDATE,
        path,
        new_path: null,
        base_revision: (await workspace.read(path)).revision,
        content,
        byte_order_mark: null,
        edits: [],
      })),
    ),
  });
}

function proposeCreation(service: EditProposalService, path: string, content: string): Promise<EditProposal> {
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.CREATE,
        path,
        new_path: null,
        base_revision: null,
        content,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

function allDecisions(proposal: EditProposal): EditDecisionState[] {
  return proposal.files.flatMap(file => file.items.map(item => item.decision));
}
