import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { EditError } from '../../errors/EditError.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { EditOperation } from '../../proposals/EditOperation.ts';
import type { EditProposal } from '../../proposals/EditProposal.ts';
import { EditProposalService } from '../../proposals/EditProposalService.ts';
import { EditApplicabilityState } from '../EditApplicabilityState.ts';
import { EditDecisionState } from '../EditDecisionState.ts';
import { ProposalReviewManager } from '../ProposalReviewManager.ts';
import { FileProposalReviewStore } from '../persistence/FileProposalReviewStore.ts';
import type { ProposalReviewStore } from '../persistence/ProposalReviewStore.ts';

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
  describe(ProposalReviewManager.prototype.accept, () => {
    it('does not touch the workspace when the applying checkpoint cannot be persisted, then retries once', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      await fixture.manager.stage(proposal);
      fixture.store.failSaveCall(3);

      await expect(fixture.manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.PERSISTENCE,
      });

      expect(fixture.workspace.replaceCalls).toBe(0);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('base');

      await fixture.manager.accept(proposal.files[0]!.items[0]!.id);

      expect(fixture.workspace.replaceCalls).toBe(1);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
      expect(fixture.manager.activeReviews).toStrictEqual([]);
    });

    it('recovers an applied edit after its completed checkpoint fails without writing it twice', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      await fixture.manager.stage(proposal);
      fixture.store.failSaveCall(4);

      await expect(fixture.manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.PERSISTENCE,
      });
      expect(fixture.workspace.replaceCalls).toBe(1);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
      await expect(fixture.manager.accept(proposal.files[0]!.items[0]!.id)).resolves.toBeUndefined();
      expect(fixture.workspace.replaceCalls).toBe(1);
      expect(fixture.manager.activeReviews).toStrictEqual([]);

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.replaceCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
    });

    it('recovers when the workspace commits a replacement but reports an I/O failure afterward', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      await fixture.manager.stage(proposal);
      fixture.workspace.failAfterNextReplace();

      await expect(fixture.manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toThrow(
        'Injected failure after replace committed.',
      );
      expect(fixture.workspace.replaceCalls).toBe(1);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
      await expect(fixture.manager.accept(proposal.files[0]!.items[0]!.id)).resolves.toBeUndefined();
      expect(fixture.workspace.replaceCalls).toBe(1);
      expect(fixture.manager.activeReviews).toStrictEqual([]);

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.replaceCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
    });
  });

  describe(ProposalReviewManager.prototype.reject, () => {
    it('can retry a rejection whose checkpoint failed and does not resurrect it after restart', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      await fixture.manager.stage(proposal);
      fixture.store.failSaveCall(2);

      await expect(fixture.manager.reject(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.PERSISTENCE,
      });
      await fixture.manager.reject(proposal.files[0]!.items[0]!.id);

      expect(fixture.manager.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('base');

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(fixture.root),
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();
      expect(recovered.activeReviews).toStrictEqual([]);
    });
  });

  describe(ProposalReviewManager.prototype.rejectAll, () => {
    it('rolls every in-memory decision back when its checkpoint fails, then retries durably', async () => {
      const fixture = await createFixture();
      await writeFile(join(fixture.root, 'file.txt'), 'one\nmiddle\nthree\n');
      const proposal = await proposeTwoReplacements(fixture.service, fixture.workspace);
      await fixture.manager.stage(proposal);
      fixture.store.failSaveCall(2);

      await expect(fixture.manager.rejectAll()).rejects.toMatchObject({ reason: EditFailureReason.PERSISTENCE });

      expect(proposal.files[0]!.items.map(item => item.decision)).toStrictEqual([
        EditDecisionState.PENDING,
        EditDecisionState.PENDING,
      ]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');

      await fixture.manager.rejectAll();

      expect(fixture.manager.activeReviews).toStrictEqual([]);
      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(fixture.root),
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();
      expect(recovered.activeReviews).toStrictEqual([]);
    });
  });

  describe(ProposalReviewManager.prototype.initialize, () => {
    it('turns an applying checkpoint back into a retryable pending edit when no mutation occurred', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      const file = proposal.files[0]!;
      file.applicability = EditApplicabilityState.APPLYING;
      file.applyingItemId = file.items[0]!.id;
      await new FileProposalReviewStore(fixture.state).save([proposal]);

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      const recoveredItem = recovered.activeReviews[0]!.files[0]!.items[0]!;
      expect(recoveredItem.decision).toBe(EditDecisionState.PENDING);
      expect(recovered.activeReviews[0]!.files[0]!.applicability).toBe(EditApplicabilityState.READY);
      expect(recovered.activeReviews[0]!.files[0]!.applyingItemId).toBeNull();
      expect(recoveredWorkspace.replaceCalls).toBe(0);

      await recovered.accept(recoveredItem.id);

      expect(recoveredWorkspace.replaceCalls).toBe(1);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
    });

    it('retries recovery after the reconciled checkpoint itself fails to persist', async () => {
      const fixture = await createFixture();
      const proposal = await proposeReplacement(fixture.service, fixture.workspace, 'next');
      const file = proposal.files[0]!;
      file.applicability = EditApplicabilityState.APPLYING;
      file.applyingItemId = file.items[0]!.id;
      await new FileProposalReviewStore(fixture.state).save([proposal]);
      await fixture.workspace.replace('file.txt', file.currentRevision!, 'next', false);

      const firstStore = new FaultInjectingProposalReviewStore(new FileProposalReviewStore(fixture.state));
      firstStore.failSaveCall(1);
      const firstRecovery = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(fixture.root),
        firstStore,
        new NullLogger(),
        8,
      );
      await expect(firstRecovery.initialize()).rejects.toMatchObject({ reason: EditFailureReason.PERSISTENCE });

      const secondRecovery = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(fixture.root),
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await secondRecovery.initialize();

      expect(secondRecovery.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('next');
    });

    it('recognizes a completed create from its applying checkpoint without creating it twice', async () => {
      const fixture = await createFixture();
      const proposal = await fixture.service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'created.txt',
            new_path: null,
            base_revision: null,
            content: 'created',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      markApplying(proposal);
      await new FileProposalReviewStore(fixture.state).save([proposal]);
      await new FileSystemWorkspaceTextStore(fixture.root).create('created.txt', 'created', false);

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.mutationCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'created.txt'), 'utf8')).toBe('created');
    });

    it('recognizes a completed delete from its applying checkpoint without deleting anything else', async () => {
      const fixture = await createFixture();
      const base = await fixture.workspace.read('file.txt');
      const proposal = await fixture.service.proposeStructured({
        files: [
          {
            operation: EditOperation.DELETE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      markApplying(proposal);
      await new FileProposalReviewStore(fixture.state).save([proposal]);
      await new FileSystemWorkspaceTextStore(fixture.root).delete('file.txt', base.revision);

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.mutationCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      await expect(readFile(join(fixture.root, 'file.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('recognizes a completed rename from its applying checkpoint without moving it twice', async () => {
      const fixture = await createFixture();
      const proposal = await proposeRename(fixture);
      const file = proposal.files[0]!;
      markApplying(proposal);
      await new FileProposalReviewStore(fixture.state).save([proposal]);
      await new FileSystemWorkspaceTextStore(fixture.root).rename(
        file.sourcePath,
        file.targetPath,
        file.currentRevision!,
      );

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.mutationCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'renamed.txt'), 'utf8')).toBe('base');
      await expect(readFile(join(fixture.root, 'file.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('finishes a rename interrupted between linking the target and unlinking the source', async () => {
      const fixture = await createFixture();
      const proposal = await proposeRename(fixture);
      markApplying(proposal);
      await new FileProposalReviewStore(fixture.state).save([proposal]);
      await link(join(fixture.root, 'file.txt'), join(fixture.root, 'renamed.txt'));

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();

      expect(recoveredWorkspace.mutationCalls).toBe(1);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'renamed.txt'), 'utf8')).toBe('base');
      await expect(readFile(join(fixture.root, 'file.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects a malformed checkpoint without touching the workspace', async () => {
      const fixture = await createFixture();
      await writeFile(join(fixture.state, 'active-proposal-review.json'), '{"schemaVersion":2,"proposals":[');

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );

      await expect(recovered.initialize()).rejects.toMatchObject({ reason: EditFailureReason.PERSISTENCE });
      expect(recoveredWorkspace.mutationCalls).toBe(0);
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('base');
    });

    it('rejects a structurally incomplete proposal before attempting workspace recovery', async () => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.state, 'active-proposal-review.json'),
        JSON.stringify({ schemaVersion: 2, proposals: [{ schemaVersion: 1, id: 'broken', files: [{}] }] }),
      );

      const recoveredWorkspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(fixture.root));
      const recovered = new ProposalReviewManager(
        recoveredWorkspace,
        new FileProposalReviewStore(fixture.state),
        new NullLogger(),
        8,
      );

      await expect(recovered.initialize()).rejects.toMatchObject({ reason: EditFailureReason.PERSISTENCE });
      expect(recoveredWorkspace.mutationCalls).toBe(0);
      expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('base');
    });
  });
});

class FaultInjectingProposalReviewStore implements ProposalReviewStore {
  private saveCalls = 0;
  private readonly failingSaveCalls = new Set<number>();

  constructor(private readonly delegate: ProposalReviewStore) {}

  failSaveCall(call: number): void {
    this.failingSaveCalls.add(call);
  }

  load(): Promise<EditProposal[]> {
    return this.delegate.load();
  }

  async save(proposals: readonly EditProposal[]): Promise<void> {
    this.saveCalls++;
    if (this.failingSaveCalls.delete(this.saveCalls)) {
      throw new EditError(EditFailureReason.PERSISTENCE, 'Injected checkpoint failure.');
    }
    await this.delegate.save(proposals);
  }

  clear(): Promise<void> {
    return this.delegate.clear();
  }
}

class CountingWorkspaceTextStore implements WorkspaceTextStore {
  private failReplaceAfterCommit = false;
  mutationCalls = 0;
  replaceCalls = 0;

  constructor(private readonly delegate: WorkspaceTextStore) {}

  get root(): string {
    return this.delegate.root;
  }

  get caseSensitive(): boolean {
    return this.delegate.caseSensitive;
  }

  failAfterNextReplace(): void {
    this.failReplaceAfterCommit = true;
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

  readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined> {
    return this.delegate.readOptional(path);
  }

  async create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    mode?: number,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationCalls++;
    return this.delegate.create(path, text, byteOrderMark, mode, options);
  }

  async replace(
    path: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationCalls++;
    this.replaceCalls++;
    const result = await this.delegate.replace(path, expectedRevision, text, byteOrderMark, options);
    if (this.failReplaceAfterCommit) {
      this.failReplaceAfterCommit = false;
      throw new Error('Injected failure after replace committed.');
    }
    return result;
  }

  async rename(
    source: string,
    target: string,
    expectedRevision: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    this.mutationCalls++;
    return this.delegate.rename(source, target, expectedRevision, options);
  }

  async delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void> {
    this.mutationCalls++;
    await this.delegate.delete(path, expectedRevision, options);
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'proposal-recovery-root-'));
  const state = await mkdtemp(join(tmpdir(), 'proposal-recovery-state-'));
  directories.push(root, state);
  await writeFile(join(root, 'file.txt'), 'base');
  const workspace = new CountingWorkspaceTextStore(new FileSystemWorkspaceTextStore(root));
  const store = new FaultInjectingProposalReviewStore(new FileProposalReviewStore(state));
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const manager = new ProposalReviewManager(workspace, store, new NullLogger(), 8);
  return { root, state, workspace, store, service, manager };
}

async function proposeReplacement(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  content: string,
): Promise<EditProposal> {
  const base = await workspace.read('file.txt');
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.UPDATE,
        path: 'file.txt',
        new_path: null,
        base_revision: base.revision,
        content,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

async function proposeTwoReplacements(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
): Promise<EditProposal> {
  const base = await workspace.read('file.txt');
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.UPDATE,
        path: 'file.txt',
        new_path: null,
        base_revision: base.revision,
        content: null,
        byte_order_mark: null,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            expected_text: 'one',
            replacement_text: 'ONE',
          },
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            expected_text: 'three',
            replacement_text: 'THREE',
          },
        ],
      },
    ],
  });
}

async function proposeRename(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<EditProposal> {
  const base = await fixture.workspace.read('file.txt');
  return fixture.service.proposeStructured({
    files: [
      {
        operation: EditOperation.RENAME,
        path: 'file.txt',
        new_path: 'renamed.txt',
        base_revision: base.revision,
        content: 'base',
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

function markApplying(proposal: EditProposal): void {
  const file = proposal.files[0]!;
  file.applicability = EditApplicabilityState.APPLYING;
  file.applyingItemId = file.items[0]!.id;
}
