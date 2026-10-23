import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullLogger } from '#src/observability/NullLogger.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { EditingConfiguration } from '#src/editing/configuration/EditingConfiguration.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';

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
  it.each(['recovery', 'acceptance'])(
    'preserves conflict evidence when the second synchronization rebase fails during %s',
    async action => {
      const { root, manager, service, workspace, store } = await fixture('first\nmiddle\n   \ncontext\nlast\n');
      const replace = workspace.replace.bind(workspace);
      vi.spyOn(workspace, 'replace').mockImplementation((path, revision, text, bom) =>
        replace(path, revision, text.replace('   \n', '\n'), bom),
      );
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST\nEXTRA' },
        { line: 2, expected: '   ', replacement: 'cleaned' },
        { line: 4, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      const file = proposal.files[0]!;
      expect(file.items).toHaveLength(3);
      await manager.accept(file.items[0]!.id);
      expect(file.applicability).toBe(EditApplicabilityState.STALE);
      expect(file.base!.revision).not.toBe(file.current!.revision);
      // Reject the hunk invalidated by editor cleanup. The remaining hunk can
      // move from the original base to the observed result of the accepted edit.
      await manager.reject(file.items[1]!.id);
      const before = structuredClone(file);
      const live = file.current!.text.replace('last\n', 'human\n');
      await writeFile(join(root, 'file.txt'), live);

      let observed = file;
      if (action === 'recovery') {
        const recovered = new ProposalReviewManager(workspace, store);
        await recovered.initialize();
        observed = recovered.activeReviews[0]!.files[0]!;
      } else {
        await expect(manager.accept(file.items[2]!.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      }
      expect(observed.applicability).toBe(EditApplicabilityState.STALE);
      expect(observed.base).toEqual(before.base);
      expect(observed.proposed).toEqual(before.proposed);
      expect(observed.current).toEqual(before.current);
      expect(observed.items).toEqual(before.items);
      expect((await workspace.read('file.txt')).text).toBe(live);
      const restarted = new ProposalReviewManager(workspace, store);
      await restarted.initialize();
      expect(restarted.activeReviews[0]!.files[0]!.base).toEqual(before.base);
      if (action === 'recovery') {
        await restarted.rejectAll();
        expect((await workspace.read('file.txt')).text).toBe(live);
      } else {
        // A later compatible snapshot can still complete both rebases and apply
        // the pending hunk at its new offset without repeating the accepted edit.
        const compatible = `human heading\n${before.current!.text}`;
        await writeFile(join(root, 'file.txt'), compatible);
        await restarted.accept(file.items[2]!.id);
        expect((await workspace.read('file.txt')).text).toBe(compatible.replace('last\n', 'LAST\n'));
      }
    },
  );

  it('recovers an insertion collapsed onto a replacement boundary as stale without modifying either pending edit', async () => {
    const { root, manager, service, workspace, store } = await fixture('first\nmiddle\nlast\n');
    const proposal = await proposeLineChanges(service, workspace, [
      { line: 1, expected: '', replacement: 'inserted\n' },
      { line: 2, expected: 'last', replacement: 'LAST' },
    ]);
    const items = proposal.files[0]!.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.removedText).toBe('');
    expect(items[1]!.removedText).toBe('last\n');
    await manager.stage(proposal);
    await writeFile(join(root, 'file.txt'), 'first\nlast\n');

    const recovered = new ProposalReviewManager(workspace, store);
    await expect(recovered.initialize()).resolves.toBeUndefined();
    const file = recovered.activeReviews[0]!.files[0]!;
    expect(file.applicability).toBe(EditApplicabilityState.STALE);
    expect(file.items).toEqual(items);
    await expect(recovered.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    await recovered.rejectAll();
    expect(recovered.activeReviews).toEqual([]);
    expect((await workspace.read('file.txt')).text).toBe('first\nlast\n');
  });

  it('recovers collapsed pending edit ranges as stale and leaves them inspectable and rejectable', async () => {
    const { root, manager, service, workspace, store } = await fixture('left\ntarget\nmiddle\ntarget\nright\n');
    const proposal = await proposeLineChanges(service, workspace, [
      { line: 1, expected: 'target', replacement: 'FIRST' },
      { line: 3, expected: 'target', replacement: 'SECOND' },
    ]);
    expect(proposal.files[0]!.items).toHaveLength(2);
    await manager.stage(proposal);
    await writeFile(join(root, 'file.txt'), 'left\ntarget\nright\n');

    const recovered = new ProposalReviewManager(workspace, store);
    await expect(recovered.initialize()).resolves.toBeUndefined();
    const file = recovered.activeReviews[0]!.files[0]!;
    expect(file.applicability).toBe(EditApplicabilityState.STALE);
    expect(file.items.every(item => item.decision === EditDecisionState.PENDING)).toBe(true);
    await expect(recovered.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    await recovered.rejectAll();
    expect(recovered.activeReviews).toEqual([]);
    expect((await workspace.read('file.txt')).text).toBe('left\ntarget\nright\n');
  });

  describe(ProposalReviewManager.prototype.accept, () => {
    it('retains a successful acceptance when editor whitespace cleanup conflicts with a remaining hunk', async () => {
      const { manager, service, workspace, store } = await fixture('first\nmiddle\n   \n');
      const replace = workspace.replace.bind(workspace);
      vi.spyOn(workspace, 'replace').mockImplementation((path, revision, text, bom) =>
        replace(path, revision, text.replace('   \n', '\n'), bom),
      );
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST' },
        { line: 2, expected: '   ', replacement: 'last' },
      ]);
      await manager.stage(proposal);
      const file = proposal.files[0]!;
      await manager.accept(file.items[0]!.id);
      expect(file.items[0]!.decision).toBe(EditDecisionState.ACCEPTED);
      expect(file.applicability).toBe(EditApplicabilityState.STALE);
      const recovered = new ProposalReviewManager(workspace, store);
      await recovered.initialize();
      expect(recovered.activeReviews[0]!.files[0]!.items[0]!.decision).toBe(EditDecisionState.ACCEPTED);
      await expect(recovered.accept(file.items[1]!.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      await recovered.rejectAll();
      expect((await workspace.read('file.txt')).text).toBe('FIRST\nmiddle\n\n');
      expect(recovered.pendingResults.flatMap(result => result.items.map(item => item.decision))).toEqual([
        EditDecisionState.ACCEPTED,
        EditDecisionState.REJECTED,
      ]);
    });
    it('applies both the rename and the BOM change when text is otherwise identical', async () => {
      const { manager, service, workspace, root } = await fixture('same\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.RENAME,
            path: 'file.txt',
            new_path: 'renamed.txt',
            base_revision: base.revision,
            content: base.text,
            byte_order_mark: true,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      await manager.acceptAll();
      expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe('\uFEFFsame\n');
    });
    it('retries the observed normalized edit checkpoint before allowing rejection of remaining hunks', async () => {
      const { manager, service, workspace, store } = await fixture('first\r\nmiddle\r\nlast\r\n');
      const replace = workspace.replace.bind(workspace);
      let applied = false;
      vi.spyOn(workspace, 'replace').mockImplementation(async (path, revision, text, bom) => {
        const result = await replace(path, revision, text.replaceAll(/\r\n|\r|\n/gu, '\r\n'), bom);
        applied = true;
        return result;
      });
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST\nEXTRA' },
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      const save = store.save.bind(store);
      let writable = false;
      vi.spyOn(store, 'save').mockImplementation((...args) => {
        if (applied && !writable) return Promise.reject(new Error('checkpoint unavailable'));
        return save(...args);
      });
      const items = proposal.files[0]!.items;
      await expect(manager.accept(items[0]!.id)).rejects.toThrow('checkpoint unavailable');
      expect(manager.pendingResults).toEqual([]);
      // Retry the failed checkpoint before deciding the remaining pending hunk.
      await expect(manager.rejectAll()).rejects.toThrow('checkpoint unavailable');
      expect(items[1]!.decision).toBe(EditDecisionState.PENDING);
      writable = true;
      await manager.rejectAll();
      expect(items[0]!.decision).toBe(EditDecisionState.ACCEPTED);
      expect(items[1]!.decision).toBe(EditDecisionState.REJECTED);
      expect((await workspace.read('file.txt')).text).toContain('FIRST\r\nEXTRA');
      expect(manager.pendingResults.flatMap(result => result.items.map(item => item.decision))).toContain(
        EditDecisionState.ACCEPTED,
      );
    });
    it('rebases remaining hunks against the actual CRLF text returned by an editor mutation', async () => {
      const { manager, service, workspace } = await fixture('first\r\nmiddle\r\nlast\r\n');
      const replace = workspace.replace.bind(workspace);
      vi.spyOn(workspace, 'replace').mockImplementation((path, revision, text, bom) =>
        replace(path, revision, text.replaceAll(/\r\n|\r|\n/gu, '\r\n'), bom),
      );
      const proposal = await proposeLineChanges(service, workspace, [
        { line: 0, expected: 'first', replacement: 'FIRST\nEXTRA' },
        { line: 2, expected: 'last', replacement: 'LAST' },
      ]);
      await manager.stage(proposal);
      const items = proposal.files[0]!.items;
      expect(items).toHaveLength(2);
      await manager.accept(items[0]!.id);
      expect(items[0]!.decision).toBe(EditDecisionState.ACCEPTED);
      await manager.accept(items[1]!.id);
      expect((await workspace.read('file.txt')).text).toBe('FIRST\r\nEXTRA\r\nmiddle\r\nLAST\r\n');
    });

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
      await recovered.acknowledgeResults(recovered.pendingResults.map(result => result.id));
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
  const store = new FileProposalReviewStore(state);
  const manager = new ProposalReviewManager(workspace, store, new NullLogger(), 8);
  return { root, state, workspace, service, manager, store };
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
