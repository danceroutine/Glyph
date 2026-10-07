import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '../../../observability/NullLogger.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import type { EditingConfiguration } from '../../configuration/EditingConfiguration.ts';
import { JsDiffTextDiffer } from '../../documents/JsDiffTextDiffer.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { EditOperation } from '../../proposals/EditOperation.ts';
import { EditProposalService } from '../../proposals/EditProposalService.ts';
import { FileProposalReviewStore } from '../persistence/FileProposalReviewStore.ts';
import { EditDecisionState } from '../EditDecisionState.ts';
import { EditApplicabilityState } from '../EditApplicabilityState.ts';
import { ProposalReviewManager } from '../ProposalReviewManager.ts';

const directories: string[] = [];
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576,
  maxChangedBytes: 1_048_576,
  maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 1,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe(ProposalReviewManager, () => {
  describe(ProposalReviewManager.prototype.accept, () => {
    it('recomputes Current from Base so accepting hunks in reverse order is stable', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
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
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                expected_text: 'first',
                replacement_text: 'FIRST',
              },
              {
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
                expected_text: 'last',
                replacement_text: 'LAST',
              },
            ],
          },
        ],
      });
      await manager.stage(proposal);
      const [first, last] = proposal.files[0]!.items;
      await manager.accept(last!.id);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nmiddle\nLAST\n');
      await manager.accept(first!.id);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nLAST\n');
    });

    it('produces identical bytes for every A/B/C acceptance permutation', async () => {
      for (const order of [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ]) {
        const { root, manager, service, workspace } = await fixture('a\nkeep-1\nb\nkeep-2\nc\n');
        const base = await workspace.read('file.txt');
        const proposal = await service.proposeStructured({
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
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                  expected_text: 'a',
                  replacement_text: 'A',
                },
                {
                  range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
                  expected_text: 'b',
                  replacement_text: 'B',
                },
                {
                  range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
                  expected_text: 'c',
                  replacement_text: 'C',
                },
              ],
            },
          ],
        });
        await manager.stage(proposal);
        for (const index of order) await manager.accept(proposal.files[0]!.items[index]!.id);
        expect(await readFile(join(root, 'file.txt'), 'utf8'), order.join('')).toBe('A\nkeep-1\nB\nkeep-2\nC\n');
      }
    });

    it('supports mixed accept/reject decisions without applying rejected dependent text', async () => {
      const { root, manager, service, workspace } = await fixture('const value = 1;\nkeep\nconsole.log(value);\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
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
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
                expected_text: 'value',
                replacement_text: 'renamed',
              },
              {
                range: { start: { line: 2, character: 12 }, end: { line: 2, character: 17 } },
                expected_text: 'value',
                replacement_text: 'renamed',
              },
            ],
          },
        ],
      });
      await manager.stage(proposal);
      await manager.accept(proposal.files[0]!.items[0]!.id);
      await manager.reject(proposal.files[0]!.items[1]!.id);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('const renamed = 1;\nkeep\nconsole.log(value);\n');
    });

    it('is idempotent for repeated decisions and returns a typed conflict for the opposite decision', async () => {
      const { manager, service } = await fixture('');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'new.txt',
            new_path: null,
            base_revision: null,
            content: 'new',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      const item = proposal.files[0]!.items[0]!;
      await manager.accept(item.id);
      await expect(manager.accept(item.id)).resolves.toBeUndefined();
      await expect(manager.reject(item.id)).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
    });

    it('marks same-file collaborator changes stale without overwriting them', async () => {
      const { root, manager, service, workspace } = await fixture('base');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'agent',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'collaborator');

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator');
    });

    it('keeps a later actor proposal pending when an earlier actor changes the same file', async () => {
      const { root, manager, service, workspace } = await fixture('base');
      const base = await workspace.read('file.txt');
      const first = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'first actor',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const second = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'second actor',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(first);
      await manager.stage(second);

      await manager.acceptInReview(first.id, first.files[0]!.items[0]!.id);
      await expect(manager.acceptInReview(second.id, second.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first actor');
      expect(manager.activeReviews).toEqual([second]);
      expect(second.files[0]!.applicability).toBe(EditApplicabilityState.STALE);
    });

    it('keeps rename and text decisions independent, then deletes by revision', async () => {
      const { root, manager, service, workspace } = await fixture('base\n');
      const base = await workspace.read('file.txt');
      const rename = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.RENAME,
            path: 'file.txt',
            new_path: 'nested/renamed.txt',
            base_revision: base.revision,
            content: 'changed\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(rename);
      const [pathItem, textItem] = rename.files[0]!.items;
      await manager.accept(textItem!.id);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('changed\n');
      await manager.accept(pathItem!.id);
      expect(await readFile(join(root, 'nested/renamed.txt'), 'utf8')).toBe('changed\n');

      const renamed = await workspace.read('nested/renamed.txt');
      const deletion = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.DELETE,
            path: 'nested/renamed.txt',
            new_path: null,
            base_revision: renamed.revision,
            content: null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(deletion);
      await manager.accept(deletion.files[0]!.items[0]!.id);
      await expect(readFile(join(root, 'nested/renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe(ProposalReviewManager.prototype.acceptAll, () => {
    it('preflights every pending file and performs zero writes when a later file is stale', async () => {
      const { root, state } = await fixture('ignored');
      await writeFile(join(root, 'a.txt'), 'a');
      await writeFile(join(root, 'b.txt'), 'b');
      const workspace = new FileSystemWorkspaceTextStore(root);
      const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
      const [a, b] = await Promise.all([workspace.read('a.txt'), workspace.read('b.txt')]);
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'a.txt',
            new_path: null,
            base_revision: a.revision,
            content: 'A',
            byte_order_mark: null,
            edits: [],
          },
          {
            operation: EditOperation.UPDATE,
            path: 'b.txt',
            new_path: null,
            base_revision: b.revision,
            content: 'B',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      await writeFile(join(root, 'b.txt'), 'human');

      await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a');
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('human');
    });

    it('performs zero writes when queued actor proposals overlap on the same file', async () => {
      const { root, manager, service, workspace } = await fixture('base');
      const base = await workspace.read('file.txt');
      const proposals = await Promise.all(
        ['first actor', 'second actor'].map(content =>
          service.proposeStructured({
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
          }),
        ),
      );
      for (const proposal of proposals) await manager.stage(proposal);

      await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('base');
      expect(
        manager.activeReviews.flatMap(review => review.files.flatMap(file => file.items.map(item => item.decision))),
      ).toEqual([EditDecisionState.PENDING, EditDecisionState.PENDING]);
    });
  });

  describe(ProposalReviewManager.prototype.rejectAll, () => {
    it('settles every pending item without touching workspace bytes', async () => {
      const { root, manager, service, workspace } = await fixture('base\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'changed\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      await manager.rejectAll();
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('base\n');
      expect(manager.active).toBeUndefined();
    });
  });

  describe(ProposalReviewManager.prototype.stage, () => {
    it('queues proposals from multiple actors in arrival order', async () => {
      const { manager, service } = await fixture('');
      const first = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'first.txt',
            new_path: null,
            base_revision: null,
            content: 'first',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const second = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'second.txt',
            new_path: null,
            base_revision: null,
            content: 'second',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(first);
      await manager.stage(second);

      expect(manager.activeReviews.map(review => review.id)).toEqual([first.id, second.id]);
      expect(manager.active).toBe(first);
      expect(manager.get(second.id)).toBe(second);
      expect(manager.pendingChangeCount).toBe(2);

      await manager.acceptInReview(first.id, first.files[0]!.items[0]!.id);
      expect(manager.activeReviews).toEqual([second]);
      expect(manager.pendingChangeCount).toBe(1);
      await manager.rejectInReview(second.id, second.files[0]!.items[0]!.id);
      expect(manager.activeReviews).toEqual([]);
      expect(manager.pendingChangeCount).toBe(0);
    });

    it('rejects another proposal only when the configured review queue is full', async () => {
      const { manager, service } = await fixture('', 1);
      const first = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'first.txt',
            new_path: null,
            base_revision: null,
            content: 'first',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const second = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'second.txt',
            new_path: null,
            base_revision: null,
            content: 'second',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(first);
      await expect(manager.stage(second)).rejects.toMatchObject({ reason: EditFailureReason.ACTIVE_REVIEW_LIMIT });
    });
  });

  describe(ProposalReviewManager.prototype.initialize, () => {
    it('rejects an unbound legacy checkpoint because its workspace identity cannot be validated', async () => {
      const { root, state, service } = await fixture('');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'legacy.txt',
            new_path: null,
            base_revision: null,
            content: 'legacy',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await writeFile(join(state, 'active-proposal-review.json'), JSON.stringify(proposal));

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await expect(recovered.initialize()).rejects.toMatchObject({ reason: EditFailureReason.PERSISTENCE });
      expect(recovered.activeReviews).toEqual([]);
    });

    it('recovers multiple actor proposals in queue order', async () => {
      const { root, state, manager, service } = await fixture('');
      const first = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'first.txt',
            new_path: null,
            base_revision: null,
            content: 'first',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const second = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'second.txt',
            new_path: null,
            base_revision: null,
            content: 'second',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(first);
      await manager.stage(second);

      const checkpoint = JSON.parse(await readFile(join(state, 'active-proposal-review.json'), 'utf8')) as {
        schemaVersion: number;
        workspaceIdentity: string;
        proposals: { id: string }[];
      };
      expect(checkpoint).toMatchObject({
        schemaVersion: 3,
        workspaceIdentity: root,
        proposals: [{ id: first.id }, { id: second.id }],
      });

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await recovered.initialize();

      expect(recovered.activeReviews.map(review => review.id)).toEqual([first.id, second.id]);
    });

    it('recovers pending decisions and revisions from the persisted checkpoint', async () => {
      const { root, state, manager, service, workspace } = await fixture('base');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'next',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      if (process.platform !== 'win32') {
        expect((await stat(join(state, 'active-proposal-review.json'))).mode & 0o777).toBe(0o600);
      }
      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await recovered.initialize();
      expect(recovered.active?.id).toBe(proposal.id);
      expect(recovered.active?.files[0]?.items[0]?.decision).toBe(EditDecisionState.PENDING);
    });

    it('recovers a partially accepted multi-hunk session', async () => {
      const { root, state, manager, service, workspace } = await fixture('one\nmiddle\nthree\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
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
      await manager.stage(proposal);
      await manager.accept(proposal.files[0]!.items[0]!.id);
      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await recovered.initialize();

      expect(recovered.active?.files[0]?.items.map(item => item.decision)).toEqual([
        EditDecisionState.ACCEPTED,
        EditDecisionState.PENDING,
      ]);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('ONE\nmiddle\nthree\n');
    });

    it('reconciles an in-progress checkpoint whose atomic write completed before restart', async () => {
      const { root, state, service, workspace } = await fixture('one\nmiddle\nthree\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
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
      const file = proposal.files[0]!;
      const applying = file.items[0]!;
      file.applyingItemId = applying.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await new FileProposalReviewStore(state).save([proposal], root);
      await workspace.replace('file.txt', base.revision, 'ONE\nmiddle\nthree\n', false);

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await recovered.initialize();

      expect(recovered.active?.files[0]?.items.map(item => item.decision)).toEqual([
        EditDecisionState.ACCEPTED,
        EditDecisionState.PENDING,
      ]);
      expect(recovered.active?.files[0]?.applyingItemId).toBeNull();
    });
  });
});

async function fixture(text: string, maxActiveReviews = 8) {
  const root = await mkdtemp(join(tmpdir(), 'edit-session-root-'));
  const state = await mkdtemp(join(tmpdir(), 'edit-session-state-'));
  directories.push(root, state);
  if (text !== '') await writeFile(join(root, 'file.txt'), text);
  const workspace = new FileSystemWorkspaceTextStore(root);
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const manager = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(state),
    new NullLogger(),
    maxActiveReviews,
  );
  return { root, state, workspace, service, manager };
}
