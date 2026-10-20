import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
import { ProjectToolName } from '#src/project/ProjectToolName.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullLogger } from '#src/observability/NullLogger.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { toGlyphProposalFilePreview } from '#src/desktop/host/toGlyphProposalFilePreview.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(initial = 'one\nmiddle\nthree\n') {
  const root = await mkdtemp(join(tmpdir(), 'glyph-applied-'));
  directories.push(root);
  await writeFile(join(root, 'file.txt'), initial);
  const workspace = new FileSystemWorkspaceTextStore(root);
  const store = new FileProposalReviewStore(join(root, '.reviews'));
  const manager = new ProposalReviewManager(workspace, store, new NullLogger(), 1, root, { autoApply: true });
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), {
    maxRawProposalBytes: 1_048_576,
    maxChangedBytes: 1_048_576,
    maxResultingBytesPerFile: 1_048_576,
    maxFiles: 64,
    maxTotalHunks: 256,
    maxHunksPerFile: 64,
    diffBudgetMs: 1000,
    maxActiveReviews: 1,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  });
  const proposal = async (content: string, rename?: string) =>
    service.proposeStructured({
      files: [
        {
          operation: rename ? 'RENAME' : 'UPDATE',
          path: 'file.txt',
          new_path: rename ?? null,
          base_revision: (await workspace.read('file.txt')).revision,
          content,
          byte_order_mark: null,
          edits: [],
        },
      ],
    });
  return { root, workspace, store, manager, service, proposal };
}

describe('Immediate edits with Keep/Revert review', () => {
  it('applies every hunk to disk, exposes the result to a process, and reviews hunks independently', async () => {
    const { root, manager, proposal } = await fixture();
    const edit = await proposal('ONE\nmiddle\nTHREE\n');
    await manager.stage(edit);
    const file = edit.files[0]!;
    expect(file.items).toHaveLength(2);
    expect(manager.pendingChangeCount).toBe(2);
    expect(manager.pendingResults).toEqual([]);
    const result = await promisify(execFile)(
      process.execPath,
      ['-e', "process.stdout.write(require('node:fs').readFileSync('file.txt'))"],
      { cwd: root },
    );
    expect(result.stdout).toBe('ONE\nmiddle\nTHREE\n');
    expect(toGlyphProposalFilePreview(edit.id, file)).toMatchObject({
      before: 'one\nmiddle\nthree\n',
      after: result.stdout,
    });
    await manager.acceptInReview(edit.id, file.items[0]!.id);
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe(result.stdout);
    expect(manager.pendingChangeCount).toBe(1);
    await manager.rejectInReview(edit.id, file.items[1]!.id, 'Keep the original ending');
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('ONE\nmiddle\nthree\n');
    expect(manager.activeReviews).toEqual([]);
    expect(manager.pendingResults.flatMap(result => result.items).map(item => item.decision)).toEqual([
      EditDecisionState.ACCEPTED,
      EditDecisionState.REJECTED,
    ]);
    expect(manager.pendingResults[1]?.items[0]?.rejectionComment).toBe('Keep the original ending');
  });

  it('can iterate past the pending proposal cap and revert successive edits in reverse order', async () => {
    const { root, manager, proposal } = await fixture('version 0\n');
    for (let index = 1; index <= 10; index++) await manager.stage(await proposal(`version ${index}\n`));
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('version 10\n');
    expect(manager.pendingChangeCount).toBe(10);
    await manager.rejectAll();
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('version 0\n');
    expect(manager.activeReviews).toEqual([]);
  });

  it('restores Keep/Revert after restart and preserves disjoint user edits', async () => {
    const { root, workspace, store, manager, proposal } = await fixture();
    const edit = await proposal('ONE\nmiddle\nthree\n');
    await manager.stage(edit);
    await writeFile(join(root, 'file.txt'), 'ONE\nmiddle\nuser ending\n');
    const recovered = new ProposalReviewManager(workspace, store);
    await recovered.initialize();
    expect(recovered.pendingChangeCount).toBe(1);
    await recovered.rejectInReview(edit.id, edit.files[0]!.items[0]!.id);
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nuser ending\n');
  });

  it('refuses to revert over an overlapping later edit and still allows keeping the earlier edit', async () => {
    const { root, manager, proposal } = await fixture();
    const first = await proposal('ONE\nmiddle\nthree\n');
    await manager.stage(first);
    await manager.stage(await proposal('LATEST\nmiddle\nthree\n'));
    await expect(manager.rejectInReview(first.id, first.files[0]!.items[0]!.id)).rejects.toMatchObject({
      reason: EditFailureReason.STALE,
    });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('LATEST\nmiddle\nthree\n');
    await manager.acceptAll();
    expect(manager.pendingChangeCount).toBe(0);
  });

  it('reverts a rename with content changes in the correct order', async () => {
    const { root, manager, proposal } = await fixture();
    const edit = await proposal('ONE\nmiddle\nTHREE\n', 'renamed.txt');
    await manager.stage(edit);
    expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe('ONE\nmiddle\nTHREE\n');
    await manager.rejectAll();
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
    await expect(readFile(join(root, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not apply an edit before its intent is durable', async () => {
    const { root, manager, store, proposal } = await fixture();
    vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'));
    await expect(manager.stage(await proposal('changed'))).rejects.toThrow('disk full');
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
    expect(manager.activeReviews).toEqual([]);
  });

  it('retains a completed revert across checkpoint failure and retries without writing twice', async () => {
    const { root, workspace, manager, store, proposal } = await fixture();
    const edit = await proposal('ONE\nmiddle\nthree\n');
    await manager.stage(edit);
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (reviews, identity) => {
      if (
        reviews.some(review =>
          review.files.some(file => file.items.some(item => item.appliedText?.state === 'reverted')),
        )
      )
        throw new Error('completion unavailable');
      await save(reviews, identity);
    });
    const replace = vi.spyOn(workspace, 'replace');
    await expect(manager.rejectAll()).rejects.toThrow('completion unavailable');
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
    expect(manager.hasPendingCheckpoint).toBe(true);
    expect(manager.pendingResults).toEqual([]);
    vi.mocked(store.save).mockImplementation(save);
    await manager.rejectAll();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(manager.hasPendingCheckpoint).toBe(false);
    expect(manager.activeReviews).toEqual([]);
  });

  it('recovers a revert whose workspace result was lost before checkpointing', async () => {
    const { root, workspace, manager, store, proposal } = await fixture();
    await manager.stage(await proposal('ONE\nmiddle\nthree\n'));
    const replace = workspace.replace.bind(workspace);
    vi.spyOn(workspace, 'replace').mockImplementationOnce(async (...args) => {
      await replace(...args);
      throw new Error('connection lost');
    });
    await expect(manager.rejectAll()).rejects.toThrow('connection lost');
    const recovered = new ProposalReviewManager(workspace, store);
    await recovered.initialize();
    await recovered.rejectAll();
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
    expect(recovered.pendingChangeCount).toBe(0);
  });
});

it('tells the agent edits are applied and lets its next read observe them', async () => {
  const { root, workspace, service, manager } = await fixture();
  const runtime = new ProjectToolRuntime(new ProjectAccess(root, {}, workspace), service, manager);
  const revision = (await workspace.read('file.txt')).revision;
  const result = JSON.parse(
    await runtime.execute(
      ProjectToolName.PROPOSE_PATCH,
      `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${revision}\n@@\n-one\n+ONE\n middle\n three\n*** End Patch`,
    ),
  );
  expect(result.status).toBe('APPLIED_WITH_REVERT');
  expect(result.message).toContain('iterate immediately');
  const read = JSON.parse(
    await runtime.execute(
      ProjectToolName.READ_FILE,
      JSON.stringify({ path: 'file.txt', start_line: null, end_line: null }),
    ),
  );
  expect(JSON.stringify(read)).toContain('ONE');
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('ONE\nmiddle\nthree\n');
});

it('keeps a partially applied proposal reviewable when a later hunk fails', async () => {
  const { root, workspace, manager, proposal } = await fixture();
  const replace = workspace.replace.bind(workspace);
  vi.spyOn(workspace, 'replace').mockImplementationOnce(replace).mockRejectedValueOnce(new Error('write failed'));
  await expect(manager.stage(await proposal('ONE\nmiddle\nTHREE\n'))).rejects.toThrow('write failed');
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('ONE\nmiddle\nthree\n');
  await manager.rejectAll();
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
  expect(manager.activeReviews).toEqual([]);
});

it('recovers an applied hunk after its mutation acknowledgement is lost', async () => {
  const { root, workspace, store, manager, proposal } = await fixture();
  const replace = workspace.replace.bind(workspace);
  vi.spyOn(workspace, 'replace').mockImplementationOnce(async (...args) => {
    await replace(...args);
    throw new Error('connection lost');
  });
  await expect(manager.stage(await proposal('ONE\nmiddle\nthree\n'))).rejects.toThrow('connection lost');
  const recovered = new ProposalReviewManager(workspace, store);
  await recovered.initialize();
  expect(recovered.active!.files[0]!.items[0]!.appliedText?.state).toBe('applied');
  await recovered.rejectAll();
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nthree\n');
});

it('reverts an encoding-only change without discarding later content edits', async () => {
  const { root, workspace, service, manager } = await fixture();
  const edit = await service.proposeStructured({
    files: [
      {
        operation: 'UPDATE',
        path: 'file.txt',
        new_path: null,
        base_revision: (await workspace.read('file.txt')).revision,
        content: null,
        byte_order_mark: true,
        edits: [],
      },
    ],
  });
  await manager.stage(edit);
  expect((await workspace.read('file.txt')).byteOrderMark).toBe(true);
  await writeFile(join(root, 'file.txt'), '\uFEFFone\nmiddle\nuser ending\n');
  await manager.rejectAll();
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('one\nmiddle\nuser ending\n');
});

it('dismisses a structural change that failed before any mutation without touching the occupied path', async () => {
  const { root, service, manager } = await fixture();
  const edit = await service.proposeStructured({
    files: [
      {
        operation: 'CREATE',
        path: 'new.txt',
        new_path: null,
        base_revision: null,
        content: 'agent',
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
  await writeFile(join(root, 'new.txt'), 'user');
  await expect(manager.stage(edit)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
  await manager.rejectAll();
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('user');
  expect(manager.activeReviews).toEqual([]);
});
