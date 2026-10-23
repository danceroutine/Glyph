import { describe, expect, it, vi } from 'vitest';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ProjectToolName } from '#src/project/ProjectToolName.js';
import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';

describe('proposal cancellation boundaries', () => {
  it.each([ProjectToolName.PROPOSE_PATCH, ProjectToolName.PROPOSE_EDITS])(
    'does not read or stage an already cancelled %s request',
    async name => {
      const fixture = proposalFixture();
      fixture.controller.abort(new Error('cancelled'));
      await expect(fixture.runtime.execute(name, proposalInput(name), fixture.controller.signal)).rejects.toThrow(
        'cancelled',
      );
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.diff).not.toHaveBeenCalled();
      expect(fixture.stage).not.toHaveBeenCalled();
    },
  );

  it.each([ProjectToolName.PROPOSE_PATCH, ProjectToolName.PROPOSE_EDITS])(
    'does not diff or stage %s after cancellation during its source read',
    async name => {
      const fixture = proposalFixture();
      const started = deferred<void>();
      const read = deferred<WorkspaceTextSnapshot>();
      fixture.read.mockImplementationOnce(() => {
        started.resolve();
        return read.promise;
      });
      const pending = fixture.runtime.execute(name, proposalInput(name), fixture.controller.signal);
      await started.promise;
      fixture.controller.abort(new Error('cancelled during source read'));
      read.resolve(snapshot());
      await expect(pending).rejects.toThrow('cancelled during source read');
      expect(fixture.diff).not.toHaveBeenCalled();
      expect(fixture.stage).not.toHaveBeenCalled();
    },
  );

  it('does not diff or stage a rename cancelled while checking its destination', async () => {
    const fixture = proposalFixture();
    const started = deferred<void>();
    const target = deferred<boolean>();
    fixture.exists.mockImplementation(() => {
      started.resolve();
      return target.promise;
    });
    const pending = fixture.runtime.execute(
      ProjectToolName.PROPOSE_EDITS,
      JSON.stringify({
        files: [
          {
            operation: EditOperation.RENAME,
            path: 'file.txt',
            new_path: 'renamed.txt',
            base_revision: 'base',
            content: 'after\n',
            byte_order_mark: false,
            edits: [],
          },
        ],
      }),
      fixture.controller.signal,
    );
    await started.promise;
    fixture.controller.abort(new Error('cancelled during destination read'));
    target.resolve(false);
    await expect(pending).rejects.toThrow('cancelled during destination read');
    expect(fixture.diff).not.toHaveBeenCalled();
    expect(fixture.stage).not.toHaveBeenCalled();
  });

  it('checks cancellation again between proposal compilation and durable staging', async () => {
    const fixture = proposalFixture();
    const compile = vi.spyOn(fixture.service, 'proposeStructured').mockImplementation(async () => {
      fixture.controller.abort(new Error('cancelled after compile'));
      return proposal();
    });
    try {
      await expect(
        fixture.runtime.execute(
          ProjectToolName.PROPOSE_EDITS,
          proposalInput(ProjectToolName.PROPOSE_EDITS),
          fixture.controller.signal,
        ),
      ).rejects.toThrow('cancelled after compile');
      expect(fixture.stage).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it('finishes an already dispatched stage and reports its durable result despite later cancellation', async () => {
    const fixture = proposalFixture();
    const started = deferred<void>();
    const saved = deferred<void>();
    fixture.stage.mockImplementationOnce(() => {
      started.resolve();
      return saved.promise;
    });
    const pending = fixture.runtime.execute(
      ProjectToolName.PROPOSE_EDITS,
      proposalInput(ProjectToolName.PROPOSE_EDITS),
      fixture.controller.signal,
    );
    await started.promise;
    fixture.controller.abort(new Error('cancelled during save'));
    saved.resolve();
    expect(JSON.parse(await pending)).toMatchObject({ status: 'STAGED_FOR_REVIEW' });
    expect(fixture.stage).toHaveBeenCalledTimes(1);
  });
});

function proposalFixture() {
  const controller = new AbortController();
  const read = vi.fn(async (_path: string): Promise<WorkspaceTextSnapshot | undefined> => snapshot());
  const exists = vi.fn(async (_path: string): Promise<boolean> => false);
  const workspace = {
    caseSensitive: true,
    normalizePath: (path: string) => path,
    canonicalPath: async (path: string) => `/fixture/${path}`,
    read,
    readOptional: read,
    exists,
  } as unknown as WorkspaceTextStore;
  const differ = new JsDiffTextDiffer();
  const diff = vi.spyOn(differ, 'createReviewItems');
  const service = new EditProposalService(workspace, differ, {
    maxRawProposalBytes: 1024 * 1024,
    maxChangedBytes: 1024 * 1024,
    maxResultingBytesPerFile: 1024 * 1024,
    maxFiles: 64,
    maxTotalHunks: 256,
    maxHunksPerFile: 64,
    diffBudgetMs: 1000,
    maxActiveReviews: 1,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  });
  const stage = vi.fn(async (_proposal: EditProposal) => {});
  const runtime = new ProjectToolRuntime(
    { definitions: [] } as unknown as ProjectAccess,
    service,
    { stage, activeReviews: [] } as unknown as ProposalReviewManager,
    new NullLogger(),
  );
  return { controller, read, exists, diff, stage, runtime, service };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(): WorkspaceTextSnapshot {
  return {
    path: 'file.txt',
    text: 'before\n',
    revision: 'base',
    identity: 'inode',
    byteLength: 7,
    byteOrderMark: false,
    mode: 0o644,
  };
}

function proposal(): EditProposal {
  return EditProposal.from({
    id: 'proposal',
    schemaVersion: 1,
    source: 'structured',
    createdAt: new Date(0).toISOString(),
    files: [],
  });
}

function proposalInput(name: ProjectToolName): string {
  if (name === ProjectToolName.PROPOSE_PATCH)
    return '*** Begin Patch\n*** Update File: file.txt\n*** Revision: base\n@@\n-before\n+after\n*** End Patch';
  return JSON.stringify({
    files: [
      {
        operation: EditOperation.UPDATE,
        path: 'file.txt',
        new_path: null,
        base_revision: 'base',
        content: 'after\n',
        byte_order_mark: false,
        edits: [],
      },
    ],
  });
}
