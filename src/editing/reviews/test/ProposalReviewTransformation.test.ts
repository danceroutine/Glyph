import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { EditApplicabilityState } from '../EditApplicabilityState.ts';
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
  describe(ProposalReviewManager.prototype.accept, () => {
    it('merges a non-overlapping human edit made after the proposal was staged', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'FIRST\nmiddle\nlast\n');

      await manager.accept(proposal.files[0]!.items[0]!.id);

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nLAST\n');
    });

    it('moves a pending range when the human inserts text before it', async () => {
      const { root, manager, service, workspace } = await fixture('first\nlast\n');
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 1, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'heading\nfirst\nlast\n');

      await manager.accept(proposal.files[0]!.items[0]!.id);

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('heading\nfirst\nLAST\n');
    });

    it('merges disjoint proposals from two actors in queue order', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const first = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST' },
      ]);
      const second = await proposeLineChanges(service, workspace, [{ line: 2, expected: 'last', replacement: 'LAST' }]);
      await manager.stage(first);
      await manager.stage(second);

      await manager.acceptInReview(first.id, first.files[0]!.items[0]!.id);
      await manager.acceptInReview(second.id, second.files[0]!.items[0]!.id);

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nLAST\n');
      expect(manager.activeReviews).toEqual([]);
    });

    it('retains a conflict when the human edit overlaps the proposed range', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 1, expected: 'middle', replacement: 'MIDDLE' },
      ]);
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'first\nhuman\nlast\n');

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nhuman\nlast\n');
      expect(proposal.files[0]!.applicability).toBe(EditApplicabilityState.STALE);
    });

    it('preserves seven non-sequential acceptances across interleaved human edits, a final conflict, restart, and recovery', async () => {
      const original = Array.from(
        { length: 8 },
        (_, index) => `${agentSource(index)}\n${humanSource(index)}\ncontext-${index}\n`,
      ).join('');
      const { root, state, manager, service, workspace } = await fixture(original);
      const proposal = await proposeLineChanges(
        service,
        workspace,
        Array.from({ length: 8 }, (_, index) => ({
          line: index * 3,
          expected: agentSource(index),
          replacement: agentReplacement(index),
        })),
      );
      await manager.stage(proposal);
      const file = proposal.files[0]!;
      const items = file.items;

      expect(items).toHaveLength(8);
      expect(items.map(item => item.removedText)).toStrictEqual(
        Array.from({ length: 8 }, (_, index) => `${agentSource(index)}\n`),
      );

      for (const index of [6, 1, 5, 0, 4, 2, 3]) {
        await manager.accept(items[index]!.id);
        const afterAgent = await readFile(join(root, 'file.txt'), 'utf8');
        expect(afterAgent).toContain(`${agentReplacement(index)}\n`);
        expect(afterAgent).toContain(`${humanSource(index)}\n`);
        await writeFile(
          join(root, 'file.txt'),
          afterAgent.replace(`${humanSource(index)}\n`, `${humanReplacement(index)}\n`),
        );
      }

      const beforeConflict = await readFile(join(root, 'file.txt'), 'utf8');
      const conflictedText = beforeConflict
        .replace(`${humanSource(7)}\n`, `${humanReplacement(7)}\n`)
        .replace(`${agentSource(7)}\n`, 'HUMAN-CONFLICT-7\n');
      await writeFile(join(root, 'file.txt'), conflictedText);

      await expect(manager.accept(items[7]!.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe(conflictedText);
      expect(items.map(item => item.decision)).toStrictEqual([
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.PENDING,
      ]);
      expect(file.applicability).toBe(EditApplicabilityState.STALE);

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
        new NullLogger(),
        8,
      );
      await recovered.initialize();
      const recoveredProposal = recovered.activeReviews[0]!;
      const recoveredFile = recoveredProposal.files[0]!;
      const recoveredItems = recoveredFile.items;

      expect(recoveredItems.map(item => item.decision)).toStrictEqual(items.map(item => item.decision));
      expect(recoveredFile.applicability).toBe(EditApplicabilityState.STALE);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe(conflictedText);

      const resolvedText = conflictedText.replace('HUMAN-CONFLICT-7\n', `${agentSource(7)}\n`);
      await writeFile(join(root, 'file.txt'), resolvedText);
      await recovered.accept(recoveredItems[7]!.id);

      const finalText = await readFile(join(root, 'file.txt'), 'utf8');
      const expectedFinalText = Array.from(
        { length: 8 },
        (_, index) => `${agentReplacement(index)}\n${humanReplacement(index)}\ncontext-${index}\n`,
      ).join('');
      expect(recovered.activeReviews).toStrictEqual([]);
      expect(finalText).toBe(expectedFinalText);
      await expect(readFile(join(state, 'active-proposal-review.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe(ProposalReviewManager.prototype.acceptAll, () => {
    it('preflights and merges disjoint queued proposals before writing either one', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const first = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST' },
      ]);
      const second = await proposeLineChanges(service, workspace, [{ line: 2, expected: 'last', replacement: 'LAST' }]);
      await manager.stage(first);
      await manager.stage(second);

      await manager.acceptAll();

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nLAST\n');
    });

    it('performs no writes when queued proposals overlap', async () => {
      const { root, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const first = await proposeLineChanges(service, workspace, [
        { line: 1, expected: 'middle', replacement: 'FIRST ACTOR' },
      ]);
      const second = await proposeLineChanges(service, workspace, [
        { line: 1, expected: 'middle', replacement: 'SECOND ACTOR' },
      ]);
      await manager.stage(first);
      await manager.stage(second);

      await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nmiddle\nlast\n');
    });
  });

  describe(ProposalReviewManager.prototype.initialize, () => {
    it('rebases a recovered proposal over a compatible human edit', async () => {
      const { root, state, manager, service, workspace } = await fixture('first\nmiddle\nlast\n');
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'FIRST\nmiddle\nlast\n');

      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(root),
        new FileProposalReviewStore(state),
      );
      await recovered.initialize();
      const recoveredProposal = recovered.activeReviews[0]!;
      await recovered.accept(recoveredProposal.files[0]!.items[0]!.id);

      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nLAST\n');
    });
  });
});

async function proposeLineChanges(
  service: EditProposalService,
  workspace: FileSystemWorkspaceTextStore,
  changes: readonly { readonly line: number; readonly expected: string; readonly replacement: string }[],
) {
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
        edits: changes.map(({ line, expected, replacement }) => ({
          range: { start: { line, character: 0 }, end: { line, character: expected.length } },
          expected_text: expected,
          replacement_text: replacement,
        })),
      },
    ],
  });
}

async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'proposal-transform-root-'));
  const state = await mkdtemp(join(tmpdir(), 'proposal-transform-state-'));
  directories.push(root, state);
  await writeFile(join(root, 'file.txt'), text);
  const workspace = new FileSystemWorkspaceTextStore(root);
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state), new NullLogger(), 8);
  return { root, state, workspace, service, manager };
}

function agentSource(index: number): string {
  return `agent-${index}`;
}

function agentReplacement(index: number): string {
  return `AGENT-${index}-ACCEPTED-${'x'.repeat(index + 1)}`;
}

function humanSource(index: number): string {
  return `human-${index}`;
}

function humanReplacement(index: number): string {
  return `human-compatible-${index}-${'y'.repeat(index + 2)}`;
}
