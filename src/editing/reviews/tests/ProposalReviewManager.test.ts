import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullLogger } from '#src/observability/NullLogger.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { OverlappingWorkspaceFixture } from '#src/workspace/tests/fixtures/OverlappingWorkspaceFixture.js';
import type { EditingConfiguration } from '#src/editing/configuration/EditingConfiguration.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import {
  ProposalReviewChangeType,
  ProposalReviewManager,
  type ProposalReviewChange,
} from '#src/editing/reviews/ProposalReviewManager.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { ProposalReviewStore } from '#src/editing/reviews/persistence/ProposalReviewStore.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';
import type { Logger } from '#src/observability/Logger.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
import { reviewResults__TESTING_ONLY as reviewResults } from '#src/editing/reviews/ProposalReviewManager.js';
import { anEditProposal } from '#src/editing/proposals/tests/fixtures/anEditProposal.ts';
import { aFileEditPlan } from '#src/editing/proposals/tests/fixtures/aFileEditPlan.ts';
import { anEditReviewItem } from '#src/editing/reviews/tests/fixtures/anEditReviewItem.ts';

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

describe(reviewResults, () => {
  it('reports an automatically kept item as accepted before its explicit decision changes', () => {
    const proposal = anEditProposal({
      id: 'proposal',
      schemaVersion: 1 as const,
      source: 'structured' as const,
      createdAt: new Date().toISOString(),
      files: [
        aFileEditPlan({
          id: 'file',
          automatic: { itemId: 'item', state: 'kept', before: null, appliedRevision: null },
          items: [anEditReviewItem({ id: 'item', decision: EditDecisionState.PENDING })],
        }),
      ],
    });
    expect(reviewResults(proposal)).toEqual([
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            decision: 'ACCEPTED',
            itemId: 'item',
          }),
        ]),
      }),
    ]);
  });
});

describe(ProposalReviewManager, () => {
  it.each([EditOperation.CREATE, EditOperation.DELETE, EditOperation.RENAME])(
    'automatically applies %s and retains a durable guarded Revert after receipt delivery',
    async operation => {
      const { root, state, service, workspace } = await fixture('base');
      const store = new FileProposalReviewStore(state);
      const manager = new ProposalReviewManager(workspace, store, new NullLogger(), 8, root, {
        autoApplyStructural: true,
      });
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation,
            path: operation === EditOperation.CREATE ? 'new.txt' : 'file.txt',
            new_path: operation === EditOperation.RENAME ? 'renamed.txt' : null,
            base_revision: operation === EditOperation.CREATE ? null : base.revision,
            content: operation === EditOperation.CREATE ? 'created' : null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(proposal);
      const file = proposal.files[0]!;
      expect(file.automatic?.state).toBe('applied');
      expect(manager.pendingChangeCount).toBe(1);
      await manager.acknowledgeResults(manager.pendingResults.map(result => result.id));
      const recovered = new ProposalReviewManager(workspace, store);
      await recovered.initialize();
      expect(recovered.active?.files[0]?.automatic?.state).toBe('applied');
      await recovered.settleAutomatic(proposal.id, file.automatic!.itemId, false);
      expect(recovered.active).toBeUndefined();
      expect((await workspace.read('file.txt')).text).toBe('base');
      if (operation === EditOperation.CREATE) expect(await workspace.exists('new.txt')).toBe(false);
      if (operation === EditOperation.RENAME) expect(await workspace.exists('renamed.txt')).toBe(false);
      expect(recovered.pendingResults[0]?.id).toContain(':reverted');
    },
  );

  it('persists rejection comments in recovered receipts and rolls them back after a failed save', async () => {
    const { root, state, service, workspace } = await fixture('base');
    const store = new FileProposalReviewStore(state);
    const manager = new ProposalReviewManager(workspace, store);
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
    const item = proposal.files[0]!.items[0]!;
    await expect(manager.rejectInReview(proposal.id, item.id, '  ')).rejects.toThrow('Review comments');
    await expect(manager.rejectInReview(proposal.id, item.id, 'x'.repeat(4001))).rejects.toThrow('Review comments');
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(manager.rejectInReview(proposal.id, item.id, 'Keep the existing API.')).rejects.toThrow(
      'disk unavailable',
    );
    expect(item.decision).toBe(EditDecisionState.PENDING);
    expect(item.rejectionComment).toBeUndefined();
    expect(manager.pendingResults).toEqual([]);
    await manager.rejectInReview(proposal.id, item.id, '  Keep the existing API.  ');
    const recovered = new ProposalReviewManager(
      new FileSystemWorkspaceTextStore(root),
      new FileProposalReviewStore(state),
    );
    await recovered.initialize();
    expect(recovered.pendingResults[0]?.items[0]).toMatchObject({
      decision: EditDecisionState.REJECTED,
      rejectionComment: 'Keep the existing API.',
    });
    expect((await workspace.read('file.txt')).text).toBe('base');
  });

  it.each(['\uD800', '\uDC00'])(
    'retains a persisted malformed filename %j as a stale and rejectable review',
    async path => {
      const { service, workspace } = await fixture('');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'valid.txt',
            new_path: null,
            base_revision: null,
            content: 'new',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const file = proposal.files[0]!;
      Object.assign(file, { sourcePath: path, targetPath: path, currentPath: path });
      const manager = new ProposalReviewManager(workspace, {
        load: async () => [proposal],
        save: async () => {},
        clear: async () => {},
      });
      await manager.initialize();
      expect(manager.active?.files[0]?.applicability).toBe(EditApplicabilityState.STALE);
      await manager.rejectAll();
      expect(manager.pendingResults[0]?.items[0]?.decision).toBe(EditDecisionState.REJECTED);
    },
  );

  it.each([
    { label: 'accepts distinct case-sensitive filenames together', first: 'foo.ts', second: 'Foo.ts', alias: false },
    {
      label: 'accepts distinct Unicode spellings together without NFC folding',
      first: 'caf\u00E9.txt',
      second: 'cafe\u0301.txt',
      alias: false,
    },
    {
      label: 'rejects real filesystem aliases during compilation and batch acceptance before any write',
      first: 'caf\u00E9.txt',
      second: 'cafe\u0301.txt',
      alias: true,
    },
  ])('$label', async ({ first, second, alias }) => {
    // An in-memory case-sensitive filesystem keeps this portable on macOS.
    const files = new Map([
      [first, 'lower'],
      [second, alias ? 'lower' : 'upper'],
    ]);
    const snapshot = (path: string): WorkspaceTextSnapshot => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`Missing ${path}`);
      return {
        path,
        text,
        revision: text,
        identity: alias ? 'same-inode' : path,
        byteLength: text.length,
        byteOrderMark: false,
        mode: 0o644,
      };
    };
    const unsupported = async (): Promise<never> => {
      throw new Error('Unexpected structural mutation');
    };
    const workspace: WorkspaceTextStore = {
      root: '/fixture',
      caseSensitive: true,
      mutationConsistency: WorkspaceMutationConsistency.ATOMIC_VERSIONED,
      normalizePath: path => path,
      canonicalPath: async path => `/fixture/${path}`,
      exists: async path => files.has(path),
      list: async () => ({ files: [...files.keys()], truncated: false }),
      read: async path => snapshot(path),
      readOptional: async path => (files.has(path) ? snapshot(path) : undefined),
      replace: async (path, revision, text) => {
        expect(snapshot(path).revision).toBe(revision);
        files.set(path, text);
        return snapshot(path);
      },
      create: unsupported,
      rename: unsupported,
      delete: unsupported,
    };
    const logger = new NullLogger();
    const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, logger);
    const manager = new ProposalReviewManager(
      workspace,
      { load: async () => [], save: async () => {}, clear: async () => {} },
      logger,
    );
    await manager.initialize();
    const input = {
      files: [...files].map(([path, text]) => ({
        operation: EditOperation.UPDATE,
        path,
        new_path: null,
        base_revision: text,
        content: null,
        byte_order_mark: null,
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } },
            expected_text: text,
            replacement_text: text.toUpperCase(),
          },
        ],
      })),
    };
    if (alias) {
      await expect(service.proposeStructured(input)).rejects.toThrow('same filesystem identity');
      for (const file of input.files) await manager.stage(await service.proposeStructured({ files: [file] }));
      await expect(manager.acceptAll()).rejects.toThrow();
      expect([...files.values()]).toEqual(['lower', 'lower']);
      return;
    }
    const proposal = await service.proposeStructured(input);
    await manager.stage(proposal);
    await manager.acceptAll();
    expect([...files]).toEqual([
      [first, 'LOWER'],
      [second, 'UPPER'],
    ]);
    expect(manager.activeReviews).toEqual([]);
  });

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
    it.each(['pkg/new', 'pkg/new/file'])(
      'performs zero mutations when a rename claims a created physical path at %s',
      async target => {
        const base = await fixture('base');
        await mkdir(join(base.root, 'pkg'));
        await writeFile(join(base.root, 'pkg', 'source.txt'), 'base');
        const workspace = new OverlappingWorkspaceFixture(base.root);
        const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
        const manager = new ProposalReviewManager(
          workspace,
          new FileProposalReviewStore(base.state),
          new NullLogger(),
          8,
        );
        const source = await workspace.read('pkg/source.txt');
        await manager.stage(
          await service.proposeStructured({
            files: [
              {
                operation: EditOperation.CREATE,
                path: 'repo/pkg/new',
                new_path: null,
                base_revision: null,
                content: 'new',
                byte_order_mark: null,
                edits: [],
              },
            ],
          }),
        );
        await manager.stage(
          await service.proposeStructured({
            files: [
              {
                operation: EditOperation.RENAME,
                path: 'pkg/source.txt',
                new_path: target,
                base_revision: source.revision,
                content: null,
                byte_order_mark: null,
                edits: [],
              },
            ],
          }),
        );
        const create = vi.spyOn(workspace, 'create');
        const rename = vi.spyOn(workspace, 'rename');
        await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
        expect(create).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(await workspace.read('pkg/source.txt')).toMatchObject({ text: 'base' });
      },
    );

    it.each(
      [
        { paths: ['repo/pkg/a', 'pkg/a'], name: 'duplicate prospective files' },
        { paths: ['repo/pkg/a', 'pkg/a/b'], name: 'physical ancestors' },
        { paths: ['pkg/a/b', 'repo/pkg/a'], name: 'physical ancestors in reverse order' },
      ].flatMap(example => [false, true].map(combined => ({ ...example, combined }))),
    )(
      'performs zero mutations for $name across overlapping roots when combined review is $combined',
      async ({ paths, combined }) => {
        const base = await fixture('');
        await mkdir(join(base.root, 'pkg'));
        const workspace = new OverlappingWorkspaceFixture(base.root);
        const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
        const manager = new ProposalReviewManager(
          workspace,
          new FileProposalReviewStore(base.state),
          new NullLogger(),
          8,
        );
        const proposals = await Promise.all(
          paths.map(path =>
            service.proposeStructured({
              files: [
                {
                  operation: EditOperation.CREATE,
                  path,
                  new_path: null,
                  base_revision: null,
                  content: 'new',
                  byte_order_mark: null,
                  edits: [],
                },
              ],
            }),
          ),
        );
        if (combined)
          await manager.stage(
            EditProposal.from({
              ...proposals[0]!.toRecord(),
              files: proposals.flatMap(proposal => proposal.files),
            }),
          );
        else for (const proposal of proposals) await manager.stage(proposal);
        const create = vi.spyOn(workspace, 'create');
        await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
        expect(create).not.toHaveBeenCalled();
        expect(manager.pendingResults).toEqual([]);
        expect(manager.pendingChangeCount).toBe(2);
      },
    );

    it.each([
      { paths: ['a', 'a/b'], name: 'a parent followed by its child', caseSensitive: true },
      { paths: ['a/b', 'a'], name: 'a child followed by its parent', caseSensitive: true },
      { paths: ['a/deep/b', 'a'], name: 'a deep child followed by its parent', caseSensitive: true },
      { paths: ['A', 'a/b'], name: 'case-insensitive parent aliases', caseSensitive: false },
    ])('performs zero mutations when queued proposals create $name', async ({ paths, caseSensitive }) => {
      const { manager, service, workspace } = await fixture('', 8, { caseSensitive });
      for (const path of paths) {
        await manager.stage(
          await service.proposeStructured({
            files: [
              {
                operation: EditOperation.CREATE,
                path,
                new_path: null,
                base_revision: null,
                content: 'new',
                byte_order_mark: null,
                edits: [],
              },
            ],
          }),
        );
      }
      const create = vi.spyOn(workspace, 'create');

      await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
      expect(create).not.toHaveBeenCalled();
      expect(manager.pendingResults).toEqual([]);
      expect(manager.pendingChangeCount).toBe(2);
      await manager.rejectAll();
    });

    it('accepts queued sibling paths and case-distinct ancestors without false collisions', async () => {
      const { manager, service, workspace } = await fixture('', 8, { caseSensitive: true });
      const paths = ['A', 'a/b', 'a/c', 'ab'];
      for (const path of paths) {
        await manager.stage(
          await service.proposeStructured({
            files: [
              {
                operation: EditOperation.CREATE,
                path,
                new_path: null,
                base_revision: null,
                content: 'new',
                byte_order_mark: null,
                edits: [],
              },
            ],
          }),
        );
      }
      // Simulate the declared case-sensitive store independently of the host volume.
      const snapshots = new Map(
        manager.activeReviews.flatMap(review => review.files.map(file => [file.targetPath, file.proposed] as const)),
      );
      const create = vi.spyOn(workspace, 'create').mockImplementation(async path => snapshots.get(path)!);
      await manager.acceptAll();
      expect(create.mock.calls.map(([path]) => path)).toEqual(paths);
      expect(manager.pendingChangeCount).toBe(0);
    });

    it.each([false, true])(
      'rejects a queued rename destination under a created file before mutations when rename arrives first is %s',
      async renameFirst => {
        const { manager, service, workspace } = await fixture('base');
        const base = await workspace.read('file.txt');
        const creation = await service.proposeStructured({
          files: [
            {
              operation: EditOperation.CREATE,
              path: 'a',
              new_path: null,
              base_revision: null,
              content: 'new',
              byte_order_mark: null,
              edits: [],
            },
          ],
        });
        const rename = await service.proposeStructured({
          files: [
            {
              operation: EditOperation.RENAME,
              path: 'file.txt',
              new_path: 'a/b',
              base_revision: base.revision,
              content: null,
              byte_order_mark: null,
              edits: [],
            },
          ],
        });
        for (const proposal of renameFirst ? [rename, creation] : [creation, rename]) await manager.stage(proposal);
        const create = vi.spyOn(workspace, 'create');
        const move = vi.spyOn(workspace, 'rename');

        await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
        expect(create).not.toHaveBeenCalled();
        expect(move).not.toHaveBeenCalled();
        expect(manager.pendingResults).toEqual([]);
        expect(manager.pendingChangeCount).toBe(2);
      },
    );

    it.each(['large file', 'binary file', 'directory'] as const)(
      'rejects a rename collision with a %s using metadata before reading its content or writing any file',
      async collision => {
        const { root, manager, service, workspace } = await fixture('source');
        const base = await workspace.read('file.txt');
        const proposal = await service.proposeStructured({
          files: [
            {
              operation: EditOperation.RENAME,
              path: 'file.txt',
              new_path: 'destination.txt',
              base_revision: base.revision,
              content: null,
              byte_order_mark: null,
              edits: [],
            },
          ],
        });
        await manager.stage(proposal);
        if (collision === 'directory') await mkdir(join(root, 'destination.txt'));
        else
          await writeFile(
            join(root, 'destination.txt'),
            collision === 'binary file' ? '\0binary' : 'x'.repeat(2 * 1024 * 1024),
          );
        const read = workspace.readOptional.bind(workspace);
        const destinationReads: string[] = [];
        vi.spyOn(workspace, 'readOptional').mockImplementation((path, options) => {
          if (path === 'destination.txt') destinationReads.push(path);
          return read(path, options);
        });
        const rename = vi.spyOn(workspace, 'rename');

        await expect(manager.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
        expect(destinationReads).toEqual([]);
        expect(rename).not.toHaveBeenCalled();
        expect((await workspace.read('file.txt')).text).toBe('source');
        expect(proposal.files[0]!.items.every(item => item.decision === EditDecisionState.PENDING)).toBe(true);
      },
    );

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

  it('refuses to enumerate an empty review queue', async () => {
    const { manager } = await reviewFixture({});
    const internals = manager as unknown as { requireReviews(): unknown };

    expect(() => internals.requireReviews()).toThrow(
      expect.objectContaining({
        reason: EditFailureReason.INCONSISTENT,
        message: 'There are no active edit reviews.',
      }),
    );
  });

  it('tolerates review items disappearing while a failed change is rolled back', async () => {
    const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'one\ntwo\nthree\n' });
    const proposal = await proposeUpdate(service, workspace, 'file.txt', 'ONE\ntwo\nTHREE\n');
    await manager.stage(proposal);
    vi.spyOn(workspace, 'replace').mockImplementationOnce(async () => {
      manager.active!.files[0]!.items.splice(1, 1);
      throw new Error('disk offline');
    });

    await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toThrow('disk offline');

    expect(manager.active?.files[0]?.items.map(item => item.decision)).toEqual([EditDecisionState.PENDING]);
    expect((await workspace.read('file.txt')).text).toBe('one\ntwo\nthree\n');
  });

  it('accepts a rename whose plan lost both its base and current documents during the move', async () => {
    const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' });
    const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
    await manager.stage(proposal);
    const rename = workspace.rename.bind(workspace);
    vi.spyOn(workspace, 'rename').mockImplementationOnce(async (...args) => {
      const file = manager.active!.files[0]!;
      file.base = null;
      file.current = null;
      return rename(...args);
    });

    await manager.accept(proposal.files[0]!.items[0]!.id);

    expect(store.proposals[0]?.files[0]).toMatchObject({
      currentPath: 'renamed.txt',
      base: { path: 'renamed.txt', text: 'base' },
      current: { path: 'renamed.txt', text: 'base' },
    });
    expect((await workspace.read('renamed.txt')).text).toBe('base');
  });

  describe(ProposalReviewManager.prototype.onDidChange, () => {
    it('notifies a listener until it unsubscribes', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const changes: ProposalReviewChange[] = [];
      const unsubscribe = manager.onDidChange(change => {
        changes.push(change);
      });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');

      await manager.stage(proposal);
      unsubscribe();
      await manager.rejectAll();

      expect(changes).toEqual([
        { type: ProposalReviewChangeType.STAGED, proposalIds: [proposal.id], pendingChangeCount: 1 },
      ]);
    });
  });

  describe('retainedReviews', () => {
    it('retains active reviews and settled reviews that applied structural changes', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'base', 'other.txt': 'other' },
        { autoApplyStructural: true },
      );
      const created = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(created);
      await manager.settleAutomatic(created.id, created.files[0]!.automatic!.itemId, true);
      const rejected = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(rejected);
      await manager.reject(rejected.files[0]!.items[0]!.id);
      const pending = await proposeUpdate(service, workspace, 'other.txt', 'changed');
      await manager.stage(pending);

      expect(manager.retainedReviews.map(review => review.id)).toEqual([pending.id, created.id]);
    });
  });

  describe(ProposalReviewManager.prototype.initialize, () => {
    it('restores persisted reviews without touching the workspace when reconciliation is deferred', async () => {
      const { service, workspace, manager, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'changed elsewhere');
      const recovered = recover();
      const read = vi.spyOn(workspace, 'readOptional');

      await recovered.initialize({ reconcileWorkspace: false });

      expect(recovered.active?.id).toBe(proposal.id);
      expect(recovered.active?.files[0]?.applicability).toBe(EditApplicabilityState.READY);
      expect(read).not.toHaveBeenCalled();
    });

    it('marks an interrupted structural revert as stale', async () => {
      const { service, manager, store, recover } = await reviewFixture({}, { autoApplyStructural: true });
      await manager.stage(await proposeCreate(service, 'new.txt', 'created'));
      store.proposals[0]!.files[0]!.automatic!.state = 'reverting';
      const recovered = recover();

      await recovered.initialize();

      expect(recovered.active?.files[0]?.applicability).toBe(EditApplicabilityState.STALE);
      expect(recovered.active?.files[0]?.automatic?.state).toBe('reverting');
    });

    it('completes a structural change that was accepted before its application was recorded', async () => {
      const { service, workspace, manager, store, recover } = await reviewFixture({}, { autoApplyStructural: true });
      await manager.stage(await proposeCreate(service, 'new.txt', 'created'));
      const persisted = store.proposals[0]!.files[0]!;
      persisted.automatic!.state = 'applying';
      persisted.automatic!.appliedRevision = null;
      const recovered = recover();

      await recovered.initialize();

      expect(recovered.active?.files[0]?.automatic).toMatchObject({
        state: 'applied',
        appliedRevision: (await workspace.read('new.txt')).revision,
      });
    });

    it('propagates an unexpected workspace failure while reconciling a persisted review', async () => {
      const { service, workspace, manager, recover } = await reviewFixture({ 'file.txt': 'base' });
      await manager.stage(await proposeUpdate(service, workspace, 'file.txt', 'next'));
      const recovered = recover();
      vi.spyOn(workspace, 'readOptional').mockRejectedValueOnce(new Error('workspace offline'));

      await expect(recovered.initialize()).rejects.toThrow('workspace offline');
    });

    it('treats an interrupted rename whose destination never appeared as not applied', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      const recovered = recover();

      await recovered.initialize();

      expect(recovered.active?.files[0]).toMatchObject({
        applicability: EditApplicabilityState.READY,
        applyingItemId: null,
        currentPath: 'file.txt',
      });
      expect(recovered.active?.files[0]?.items[0]?.decision).toBe(EditDecisionState.PENDING);
    });

    it('propagates an unexpected failure while inspecting an interrupted rename destination', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      const readOptional = workspace.readOptional.bind(workspace);
      vi.spyOn(workspace, 'readOptional').mockImplementation(async (path, options) =>
        path === 'renamed.txt' ? Promise.reject(new Error('destination unavailable')) : readOptional(path, options),
      );

      await expect(recover().initialize()).rejects.toThrow('destination unavailable');
    });

    it('recognizes an interrupted delete that landed and records its applied evidence', async () => {
      const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeDelete(service, workspace, 'file.txt');
      const file = proposal.files[0]!;
      const item = file.items[0]!;
      item.appliedText = { state: 'applying', before: null, after: null, revertTarget: null };
      file.applyingItemId = item.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      await rm(join(root, 'file.txt'));
      const recovered = recover();

      await recovered.initialize();

      expect(recovered.active?.files[0]?.items[0]).toMatchObject({
        decision: EditDecisionState.ACCEPTED,
        appliedText: { state: 'applied', after: null },
      });
      expect(recovered.active?.files[0]?.currentRevision).toBeNull();
    });

    it('records a landed interrupted text change while leaving a plan without prior content stale', async () => {
      const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', '');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      file.current = null;
      await store.save([proposal]);
      await writeFile(join(root, 'file.txt'), '');
      const recovered = recover();

      await recovered.initialize();

      expect(recovered.active).toBeUndefined();
      expect(store.proposals[0]?.files[0]).toMatchObject({
        applicability: EditApplicabilityState.STALE,
        applyingItemId: null,
      });
      expect(recovered.pendingResults[0]?.items[0]?.decision).toBe(EditDecisionState.ACCEPTED);
    });
  });

  describe(ProposalReviewManager.prototype.stage, () => {
    it('rejects a proposal whose review ID is already queued', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);

      await expect(manager.stage(proposal)).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'A proposal with this review ID is already queued.',
      });
    });

    it('applies only the structural part of a rename that also changes text', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'one\ntwo\n' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt', 'one\nTWO\n');

      await manager.stage(proposal);

      const file = manager.active!.files[0]!;
      expect(file.automatic?.state).toBe('applied');
      expect(file.items.map(item => [item.kind, item.decision])).toEqual([
        [EditReviewItemKind.RENAME, EditDecisionState.ACCEPTED],
        [EditReviewItemKind.TEXT, EditDecisionState.PENDING],
      ]);
      expect((await workspace.read('renamed.txt')).text).toBe('one\ntwo\n');
    });

    it('records an automatically applied creation whose acknowledgement was lost', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      const create = workspace.create.bind(workspace);
      vi.spyOn(workspace, 'create').mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new Error('connection lost');
      });
      const proposal = await proposeCreate(service, 'new.txt', 'created');

      await expect(manager.stage(proposal)).rejects.toThrow('connection lost');

      expect(manager.active?.files[0]?.automatic).toMatchObject({
        state: 'applied',
        appliedRevision: (await workspace.read('new.txt')).revision,
      });
    });
  });

  describe(ProposalReviewManager.prototype.acceptAll, () => {
    it('does nothing without active reviews', async () => {
      const { manager, store } = await reviewFixture({});
      const save = vi.spyOn(store, 'save');

      await manager.acceptAll();

      expect(save).not.toHaveBeenCalled();
    });

    it('keeps automatically applied structural changes', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeDelete(service, workspace, 'file.txt');
      await manager.stage(proposal);

      await manager.acceptAll();

      expect(manager.active).toBeUndefined();
      expect(manager.retainedReviews[0]?.files[0]?.automatic?.state).toBe('kept');
      await expect(workspace.exists('file.txt')).resolves.toBe(false);
    });

    it('recovers an interrupted acceptance before accepting the queue', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await manager.acceptAll();

      expect((await workspace.read('file.txt')).text).toBe('next');
      expect(manager.active).toBeUndefined();
    });

    it('fails when a pending text change no longer has a document to apply to', async () => {
      const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      const file = proposal.files[0]!;
      file.current = null;
      file.currentRevision = null;
      await store.save([proposal]);
      await rm(join(root, 'file.txt'));
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await expect(manager.acceptAll()).rejects.toThrow('Cannot simulate text changes without a current document.');
    });
  });

  describe(ProposalReviewManager.prototype.rejectAll, () => {
    it('recovers an interrupted acceptance that landed instead of rejecting it', async () => {
      const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      await writeFile(join(root, 'file.txt'), 'next');
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await manager.rejectAll();

      expect(manager.pendingResults.flatMap(result => result.items.map(item => item.decision))).toEqual([
        EditDecisionState.ACCEPTED,
      ]);
      expect((await workspace.read('file.txt')).text).toBe('next');
    });
  });

  describe(ProposalReviewManager.prototype.acknowledgeResults, () => {
    it('acknowledges only the named results and ignores unknown ones', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'one\ntwo\nthree\n' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'ONE\ntwo\nTHREE\n');
      await manager.stage(proposal);
      await manager.rejectAll();
      const [first, second] = manager.pendingResults;
      const save = vi.spyOn(store, 'save');

      await manager.acknowledgeResults([first!.id]);
      await manager.acknowledgeResults(['unknown-result']);

      expect(manager.pendingResults.map(result => result.id)).toEqual([second!.id]);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('clears the acknowledgements of a review whose identity changed during a failed save', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'one\ntwo\nthree\n' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'ONE\ntwo\nTHREE\n');
      await manager.stage(proposal);
      await manager.reject(proposal.files[0]!.items[0]!.id);
      const [result] = manager.pendingResults;
      vi.spyOn(store, 'save').mockImplementationOnce(async () => {
        (manager.active as unknown as { id: string }).id = 'replaced';
        throw new Error('disk full');
      });

      await expect(manager.acknowledgeResults([result!.id])).rejects.toThrow('disk full');

      expect(manager.active).toMatchObject({ id: 'replaced', acknowledgedResultIds: [] });
    });

    it('restores acknowledgements when they cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      await manager.rejectAll();
      const [result] = manager.pendingResults;
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.acknowledgeResults([result!.id])).rejects.toThrow('disk full');

      expect(manager.pendingResults.map(pending => pending.id)).toEqual([result!.id]);
      await manager.acknowledgeResults([result!.id]);
      expect(manager.pendingResults).toEqual([]);
    });
  });

  describe(ProposalReviewManager.prototype.settleAutomatic, () => {
    it('rejects an unknown review', async () => {
      const { manager } = await reviewFixture({});

      await expect(manager.settleAutomatic('missing', 'item', true)).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Unknown edit review.',
      });
    });

    it('rejects an item that is not an automatically applied change', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);

      await expect(manager.settleAutomatic(proposal.id, proposal.files[0]!.items[0]!.id, true)).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Unknown applied file change.',
      });
    });

    it('treats settling an already kept change as complete while its review stays active', async () => {
      const { service, workspace, manager, store } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const base = await workspace.read('file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'new.txt',
            new_path: null,
            base_revision: null,
            content: 'created',
            byte_order_mark: null,
            edits: [],
          },
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
      const itemId = proposal.files[0]!.automatic!.itemId;
      await manager.settleAutomatic(proposal.id, itemId, true);
      const save = vi.spyOn(store, 'save');

      await manager.settleAutomatic(proposal.id, itemId, true);
      await manager.settleAutomatic(proposal.id, itemId, false);

      expect(save).not.toHaveBeenCalled();
      expect(manager.active?.files[0]?.automatic?.state).toBe('kept');
      await expect(workspace.exists('new.txt')).resolves.toBe(true);
    });

    it('keeps the change applied when keeping it cannot be saved', async () => {
      const { service, manager, store } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, true)).rejects.toThrow(
        'disk full',
      );

      expect(manager.active?.files[0]?.automatic?.state).toBe('applied');
    });

    it('keeps the change applied when its revert intent cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false)).rejects.toThrow(
        'disk full',
      );

      expect(manager.active?.files[0]?.automatic?.state).toBe('applied');
      await expect(workspace.exists('new.txt')).resolves.toBe(true);
    });

    it('stays reverting when a retried revert intent cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      vi.spyOn(workspace, 'delete').mockRejectedValueOnce(new Error('locked'));
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('locked');
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('disk full');

      expect(manager.active?.files[0]?.automatic?.state).toBe('reverting');
    });

    it('refuses to keep a change whose revert is in progress', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      vi.spyOn(workspace, 'delete').mockRejectedValueOnce(new Error('locked'));
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('locked');

      await expect(manager.settleAutomatic(proposal.id, itemId, true)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
    });

    it('reverts a creation whose file the user already removed', async () => {
      const { service, workspace, manager, root } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      await rm(join(root, 'new.txt'));
      const remove = vi.spyOn(workspace, 'delete');

      await manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false);

      expect(remove).not.toHaveBeenCalled();
      expect(manager.retainedReviews[0]?.files[0]).toMatchObject({
        automatic: { state: 'reverted' },
        current: null,
        currentRevision: null,
      });
    });

    it('refuses to revert a creation the user has since edited', async () => {
      const { service, workspace, manager, root } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      await writeFile(join(root, 'new.txt'), 'edited');

      await expect(
        manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false),
      ).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        details: { currentRevision: (await workspace.read('new.txt')).revision },
      });
    });

    it.each([
      ['identical', 'base'],
      ['different', 'recreated'],
    ])('refuses to revert a deletion after the user recreated %s content', async (_description, content) => {
      const { service, workspace, manager, root } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeDelete(service, workspace, 'file.txt');
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), content);

      await expect(
        manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect((await workspace.read('file.txt')).text).toBe(content);
    });

    it('completes a deletion revert whose restored file landed without acknowledgement', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeDelete(service, workspace, 'file.txt');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      const create = workspace.create.bind(workspace);
      vi.spyOn(workspace, 'create').mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new Error('connection lost');
      });
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('connection lost');

      await manager.settleAutomatic(proposal.id, itemId, false);

      expect(manager.retainedReviews[0]?.files[0]?.automatic?.state).toBe('reverted');
      expect((await workspace.read('file.txt')).text).toBe('base');
    });

    it('completes a rename revert whose move landed without acknowledgement', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      const rename = workspace.rename.bind(workspace);
      vi.spyOn(workspace, 'rename').mockImplementationOnce(async (...args) => {
        await rename(...args);
        throw new Error('connection lost');
      });
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('connection lost');

      await manager.settleAutomatic(proposal.id, itemId, false);

      expect(manager.retainedReviews[0]?.files[0]).toMatchObject({
        automatic: { state: 'reverted' },
        currentPath: 'file.txt',
      });
      await expect(workspace.exists('renamed.txt')).resolves.toBe(false);
    });

    it('refuses to revert a rename after the user created a file at the original path', async () => {
      const { service, workspace, manager, root } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'base');

      await expect(
        manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    });

    it('refuses to retry a rename revert once both paths exist', async () => {
      const { service, workspace, manager, root } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      vi.spyOn(workspace, 'rename').mockRejectedValueOnce(new Error('locked'));
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('locked');
      await writeFile(join(root, 'file.txt'), 'base');

      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
    });

    it('refuses to finish a landed rename revert after the restored file changed', async () => {
      const { service, workspace, manager, root } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;
      const rename = workspace.rename.bind(workspace);
      vi.spyOn(workspace, 'rename').mockImplementationOnce(async (...args) => {
        await rename(...args);
        throw new Error('connection lost');
      });
      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('connection lost');
      await writeFile(join(root, 'file.txt'), 'edited');

      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
    });

    it.each(['deleted', 'edited'])('refuses to revert a rename whose destination was %s', async change => {
      const { service, workspace, manager, root } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApplyStructural: true },
      );
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      await manager.stage(proposal);
      if (change === 'deleted') await rm(join(root, 'renamed.txt'));
      else await writeFile(join(root, 'renamed.txt'), 'edited');

      await expect(
        manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    });

    it('applies a kept change whose earlier application failed before reaching the workspace', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      vi.spyOn(workspace, 'create').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');

      await manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, true);

      expect(manager.retainedReviews[0]?.files[0]?.automatic?.state).toBe('kept');
      expect((await workspace.read('new.txt')).text).toBe('created');
    });

    it('dismisses a reverted change whose earlier application never reached the workspace', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      vi.spyOn(workspace, 'create').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');

      await manager.settleAutomatic(proposal.id, proposal.files[0]!.automatic!.itemId, false);

      expect(manager.retainedReviews[0]?.files[0]?.automatic?.state).toBe('reverted');
      await expect(workspace.exists('new.txt')).resolves.toBe(false);
    });

    it('restores an unapplied change when dismissing it cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({}, { autoApplyStructural: true });
      vi.spyOn(workspace, 'create').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));
      const itemId = proposal.files[0]!.automatic!.itemId;

      await expect(manager.settleAutomatic(proposal.id, itemId, false)).rejects.toThrow('disk full');

      expect(manager.active?.files[0]?.automatic?.state).toBe('applying');
      expect(manager.active?.files[0]?.items[0]?.decision).toBe(EditDecisionState.PENDING);
    });

    it('recovers an interrupted structural application before keeping it', async () => {
      const { service, manager, store, recover } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      const persisted = store.proposals[0]!.files[0]!;
      persisted.automatic!.state = 'applying';
      persisted.applyingItemId = persisted.automatic!.itemId;
      persisted.items[0]!.decision = EditDecisionState.PENDING;
      const recovered = recover();
      await recovered.initialize({ reconcileWorkspace: false });

      await recovered.settleAutomatic(proposal.id, persisted.automatic!.itemId, true);

      expect(recovered.retainedReviews[0]?.files[0]?.automatic?.state).toBe('kept');
    });

    it('refuses to dismiss an interrupted structural application that became stale', async () => {
      const { service, workspace, manager, store, recover, root } = await reviewFixture(
        {},
        { autoApplyStructural: true },
      );
      vi.spyOn(workspace, 'create').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');
      const persisted = store.proposals[0]!.files[0]!;
      persisted.applyingItemId = persisted.automatic!.itemId;
      await writeFile(join(root, 'new.txt'), 'collaborator');
      const recovered = recover();
      await recovered.initialize({ reconcileWorkspace: false });

      await expect(recovered.settleAutomatic(proposal.id, persisted.automatic!.itemId, false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
      expect((await workspace.read('new.txt')).text).toBe('collaborator');
    });
  });

  describe(ProposalReviewManager.prototype.rejectInReview, () => {
    it('validates and records comments when reverting an automatically applied change', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.automatic!.itemId;

      await expect(manager.rejectInReview(proposal.id, itemId, '   ')).rejects.toThrow('Review comments');
      await expect(manager.rejectInReview(proposal.id, itemId, 'x'.repeat(4001))).rejects.toThrow('Review comments');
      await manager.rejectInReview(proposal.id, itemId, '  Not needed  ');

      expect(manager.pendingResults[0]?.items[0]?.rejectionComment).toBe('Not needed');
      await expect(workspace.exists('new.txt')).resolves.toBe(false);
    });

    it('rejects an empty comment for an applied text change', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);

      await expect(manager.rejectInReview(proposal.id, proposal.files[0]!.items[0]!.id, '   ')).rejects.toThrow(
        'Review comments',
      );
    });

    it('treats a settled item from another review as unknown', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base', 'other.txt': 'other' });
      const settled = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(settled);
      await manager.reject(settled.files[0]!.items[0]!.id);
      const active = await proposeUpdate(service, workspace, 'other.txt', 'changed');
      await manager.stage(active);

      await expect(manager.acceptInReview(active.id, settled.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Unknown review item.',
      });
    });

    it('treats an item outside the named review as unknown', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);

      await expect(manager.rejectInReview(proposal.id, 'missing-item')).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Unknown review item.',
        details: { hunkId: 'missing-item' },
      });
    });

    it('refuses to dismiss an unapplied text change after the file changed', async () => {
      const { service, workspace, manager, root } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');
      await writeFile(join(root, 'file.txt'), 'edited');

      await expect(manager.rejectInReview(proposal.id, proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
    });

    it('restores an unapplied text change when dismissing it cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.rejectInReview(proposal.id, proposal.files[0]!.items[0]!.id, 'Not this')).rejects.toThrow(
        'disk full',
      );

      expect(manager.active?.files[0]?.items[0]).toMatchObject({
        decision: EditDecisionState.PENDING,
        appliedText: { state: 'applying' },
      });
      expect(manager.active?.files[0]?.items[0]?.rejectionComment).toBeUndefined();
    });

    it('keeps an applied text change when its revert intent cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.rejectInReview(proposal.id, proposal.files[0]!.items[0]!.id)).rejects.toThrow('disk full');

      expect(manager.active?.files[0]?.items[0]?.appliedText).toMatchObject({ state: 'applied', revertTarget: null });
      expect((await workspace.read('file.txt')).text).toBe('next');
    });

    it('refuses to continue a revert that lost its target', async () => {
      const { service, workspace, manager, store, recover } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApply: true },
      );
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      const persisted = store.proposals[0]!.files[0]!.items[0]!;
      persisted.appliedText!.state = 'reverting';
      persisted.appliedText!.revertTarget = null;
      const recovered = recover();
      await recovered.initialize();

      await expect(recovered.rejectInReview(proposal.id, persisted.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });
    });

    it('refuses to retry a revert after the file changed again', async () => {
      const { service, workspace, manager, root } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.items[0]!.id;
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('locked'));
      await expect(manager.rejectInReview(proposal.id, itemId)).rejects.toThrow('locked');
      await writeFile(join(root, 'file.txt'), 'edited');

      await expect(manager.rejectInReview(proposal.id, itemId)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        details: { currentRevision: (await workspace.read('file.txt')).revision },
      });
    });
  });

  describe(ProposalReviewManager.prototype.reject, () => {
    it('reverts an automatically applied structural change', async () => {
      const { service, workspace, manager } = await reviewFixture({}, { autoApplyStructural: true });
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);

      await manager.reject(proposal.files[0]!.automatic!.itemId);

      expect(manager.retainedReviews[0]?.files[0]?.automatic?.state).toBe('reverted');
      await expect(workspace.exists('new.txt')).resolves.toBe(false);
    });

    it('rejects an item already accepted in an active review', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'one\ntwo\nthree\n' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'ONE\ntwo\nTHREE\n');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.items[0]!.id;
      await manager.accept(itemId);

      await manager.accept(itemId);
      await expect(manager.reject(itemId)).rejects.toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });

      expect((await workspace.read('file.txt')).text).toBe('ONE\ntwo\nthree\n');
    });
  });

  describe(ProposalReviewManager.prototype.accept, () => {
    it('rejects an item that no active review contains', async () => {
      const { manager } = await reviewFixture({});

      await expect(manager.accept('missing-item')).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Unknown review item.',
      });
    });

    it('rejects an item ID shared by more than one active review', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      await manager.stage(EditProposal.from({ ...structuredClone(proposal.toRecord()), id: 'copy' }));

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.AMBIGUOUS,
        message: 'Review item ID is not unique across active reviews.',
      });
    });

    it('keeps an applied text change and treats keeping it again as complete', async () => {
      const { service, workspace, manager } = await reviewFixture(
        { 'file.txt': 'one\ntwo\nthree\n' },
        { autoApply: true },
      );
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'ONE\ntwo\nTHREE\n');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.items[0]!.id;
      await manager.accept(itemId);

      await manager.acceptInReview(proposal.id, itemId);
      await expect(manager.rejectInReview(proposal.id, itemId)).rejects.toMatchObject({
        reason: EditFailureReason.DECISION_CONFLICT,
      });

      expect(manager.active?.files[0]?.items[0]?.appliedText?.state).toBe('kept');
    });

    it('keeps the applied state when keeping a text change cannot be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toThrow('disk full');

      expect(manager.active?.files[0]?.items[0]?.appliedText?.state).toBe('applied');
    });

    it('refuses to keep a text change whose revert is in progress', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      const itemId = proposal.files[0]!.items[0]!.id;
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('locked'));
      await expect(manager.reject(itemId)).rejects.toThrow('locked');

      await expect(manager.accept(itemId)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    });

    it('applies a kept text change whose earlier application failed before reaching the workspace', async () => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' }, { autoApply: true });
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');

      await manager.accept(proposal.files[0]!.items[0]!.id);

      expect((await workspace.read('file.txt')).text).toBe('next');
      expect(manager.retainedReviews).toEqual([]);
    });

    it('recovers an interrupted text application before keeping it', async () => {
      const { service, workspace, manager, store, recover } = await reviewFixture(
        { 'file.txt': 'base' },
        { autoApply: true },
      );
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('disk offline'));
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await expect(manager.stage(proposal)).rejects.toThrow('disk offline');
      const persisted = store.proposals[0]!.files[0]!;
      persisted.applyingItemId = persisted.items[0]!.id;
      persisted.applicability = EditApplicabilityState.APPLYING;
      const recovered = recover();
      await recovered.initialize({ reconcileWorkspace: false });

      await recovered.accept(persisted.items[0]!.id);

      expect((await workspace.read('file.txt')).text).toBe('next');
      expect(recovered.active).toBeUndefined();
    });

    it('recovers an interrupted acceptance before applying it', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      const file = proposal.files[0]!;
      file.applyingItemId = file.items[0]!.id;
      file.applicability = EditApplicabilityState.APPLYING;
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await manager.accept(file.items[0]!.id);

      expect((await workspace.read('file.txt')).text).toBe('next');
    });

    it('refuses to apply a text change without a current document and records no prior content', async () => {
      const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      const file = proposal.files[0]!;
      const item = file.items[0]!;
      item.appliedText = { state: 'applying', before: null, after: null, revertTarget: null };
      file.current = null;
      file.currentRevision = null;
      await store.save([proposal]);
      await rm(join(root, 'file.txt'));
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await expect(manager.accept(item.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });

      expect(manager.active?.files[0]?.items[0]?.appliedText?.before).toBeNull();
    });

    it.each([EditOperation.DELETE, EditOperation.RENAME])(
      'refuses to apply a %s whose file is expected to be absent',
      async operation => {
        const { service, workspace, store, recover, root } = await reviewFixture({ 'file.txt': 'base' });
        const proposal =
          operation === EditOperation.DELETE
            ? await proposeDelete(service, workspace, 'file.txt')
            : await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
        const file = proposal.files[0]!;
        file.current = null;
        file.currentRevision = null;
        await store.save([proposal]);
        await rm(join(root, 'file.txt'));
        const manager = recover();
        await manager.initialize({ reconcileWorkspace: false });

        await expect(manager.accept(file.items[0]!.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      },
    );

    it('records a deleted file as the applied result of a deletion', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeDelete(service, workspace, 'file.txt');
      const item = proposal.files[0]!.items[0]!;
      item.appliedText = { state: 'applying', before: null, after: null, revertTarget: null };
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await manager.accept(item.id);

      expect(store.proposals[0]?.files[0]?.items[0]?.appliedText).toMatchObject({ state: 'kept', after: null });
      await expect(workspace.exists('file.txt')).resolves.toBe(false);
    });

    it('refuses a text change that cannot be applied independently of other pending changes', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'a\nb\nc\n' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'A\nb\nC\n');
      const [first, second] = proposal.files[0]!.items;
      Object.assign(first!, { sourceStart: 0, sourceEnd: 2, removedText: 'aY', insertedText: 'X' });
      Object.assign(second!, { sourceStart: 1, sourceEnd: 2, removedText: '\n', insertedText: 'Y' });
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await expect(manager.accept(first!.id)).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect((await workspace.read('file.txt')).text).toBe('a\nb\nc\n');
    });

    it('fails when a pending text change no longer matches its own document', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'a\nb\nc\n' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'A\nb\nC\n');
      const [first] = proposal.files[0]!.items;
      Object.assign(first!, { removedText: 'zzz' });
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await expect(manager.accept(first!.id)).rejects.toThrow(
        'The transformed edit no longer matches its expected text.',
      );
    });

    it('keeps the write intent when neither the write nor its recovery can be saved', async () => {
      const { service, workspace, manager, store } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce(new Error('disk offline'));
      const save = store.save.bind(store);
      vi.spyOn(store, 'save')
        .mockImplementationOnce(save)
        .mockImplementationOnce(save)
        .mockRejectedValueOnce(new Error('disk full'));
      const itemId = proposal.files[0]!.items[0]!.id;

      await expect(manager.accept(itemId)).rejects.toThrow('disk offline');

      expect(manager.active?.files[0]).toMatchObject({
        applyingItemId: itemId,
        applicability: EditApplicabilityState.APPLYING,
      });
    });

    it('logs a workspace failure that is not an error object', async () => {
      const logger = new RecordingLogger();
      const { service, workspace, store, root } = await reviewFixture({ 'file.txt': 'base' });
      const manager = new ProposalReviewManager(workspace, store, logger, 8, root);
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      vi.spyOn(workspace, 'replace').mockRejectedValueOnce('disk offline');

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toBe('disk offline');

      expect(logger.errors).toEqual([
        expect.objectContaining({
          message: 'item.failed',
          data: expect.objectContaining({ error: { message: 'disk offline' } }),
        }),
      ]);
    });

    it.each([
      ['reading the file', 'readOptional'],
      ['checking for the file', 'exists'],
    ] as const)('propagates an unexpected workspace failure while %s', async (_description, method) => {
      const { service, workspace, manager } = await reviewFixture({ 'file.txt': 'base' });
      const proposal =
        method === 'exists'
          ? await proposeCreate(service, 'new.txt', 'created')
          : await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      vi.spyOn(workspace, method).mockRejectedValueOnce(new Error('workspace offline'));

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toThrow('workspace offline');
    });

    it('marks a creation stale when another writer creates the file first', async () => {
      const { service, workspace, manager, root } = await reviewFixture({});
      const proposal = await proposeCreate(service, 'new.txt', 'created');
      await manager.stage(proposal);
      const create = workspace.create.bind(workspace);
      vi.spyOn(workspace, 'create').mockImplementationOnce(async (...args) => {
        await writeFile(join(root, 'new.txt'), 'collaborator');
        return create(...args);
      });

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });

      expect(manager.active?.files[0]?.applicability).toBe(EditApplicabilityState.STALE);
      expect((await workspace.read('new.txt')).text).toBe('collaborator');
    });

    it('marks an update stale when its file was deleted', async () => {
      const { service, workspace, manager, root } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next');
      await manager.stage(proposal);
      await rm(join(root, 'file.txt'));

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
      });

      expect(manager.active?.files[0]?.applicability).toBe(EditApplicabilityState.STALE);
    });

    it('recognizes a landed change to a file with a byte order mark', async () => {
      const { service, workspace, manager } = await reviewFixture({
        'file.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('base\n')]),
      });
      const proposal = await proposeUpdate(service, workspace, 'file.txt', 'next\n');
      await manager.stage(proposal);
      const replace = workspace.replace.bind(workspace);
      vi.spyOn(workspace, 'replace').mockImplementationOnce(async (...args) => {
        await replace(...args);
        throw new Error('connection lost');
      });

      await expect(manager.accept(proposal.files[0]!.items[0]!.id)).rejects.toThrow('connection lost');

      expect(manager.pendingResults[0]?.items[0]?.decision).toBe(EditDecisionState.ACCEPTED);
      expect(await workspace.read('file.txt')).toMatchObject({ text: 'next\n', byteOrderMark: true });
    });

    it('accepts a rename whose plan has no recorded base', async () => {
      const { service, workspace, store, recover } = await reviewFixture({ 'file.txt': 'base' });
      const proposal = await proposeRename(service, workspace, 'file.txt', 'renamed.txt');
      proposal.files[0]!.base = null;
      await store.save([proposal]);
      const manager = recover();
      await manager.initialize({ reconcileWorkspace: false });

      await manager.accept(proposal.files[0]!.items[0]!.id);

      expect((await workspace.read('renamed.txt')).text).toBe('base');
    });
  });
});

class MemoryProposalReviewStore implements ProposalReviewStore {
  proposals: EditProposal[] = [];

  async load(): Promise<EditProposal[]> {
    return structuredClone(this.proposals);
  }

  async save(proposals: readonly EditProposal[]): Promise<void> {
    this.proposals = structuredClone([...proposals]);
  }

  async clear(): Promise<void> {
    this.proposals = [];
  }
}

class RecordingLogger implements Logger {
  readonly errors: { message: string; data: unknown }[] = [];

  forNamespace(): Logger {
    return this;
  }

  trace(): void {}

  debug(): void {}

  info(): void {}

  warn(): void {}

  error(message: string, data?: unknown): void {
    this.errors.push({ message, data });
  }
}

async function reviewFixture(
  files: Readonly<Record<string, string | Buffer>>,
  options: { readonly autoApply?: boolean; readonly autoApplyStructural?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'proposal-review-manager-'));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const workspace = new FileSystemWorkspaceTextStore(root);
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const store = new MemoryProposalReviewStore();
  const manager = new ProposalReviewManager(workspace, store, new NullLogger(), 8, root, options);
  const recover = () => new ProposalReviewManager(workspace, store, new NullLogger(), 8, root, options);
  return { root, workspace, service, store, manager, recover };
}

async function proposeUpdate(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  path: string,
  content: string,
): Promise<EditProposal> {
  const base = await workspace.read(path);
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.UPDATE,
        path,
        new_path: null,
        base_revision: base.revision,
        content,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

function proposeCreate(service: EditProposalService, path: string, content: string): Promise<EditProposal> {
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

async function proposeDelete(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  path: string,
): Promise<EditProposal> {
  const base = await workspace.read(path);
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.DELETE,
        path,
        new_path: null,
        base_revision: base.revision,
        content: null,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

async function proposeRename(
  service: EditProposalService,
  workspace: WorkspaceTextStore,
  path: string,
  newPath: string,
  content: string | null = null,
): Promise<EditProposal> {
  const base = await workspace.read(path);
  return service.proposeStructured({
    files: [
      {
        operation: EditOperation.RENAME,
        path,
        new_path: newPath,
        base_revision: base.revision,
        content,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
}

async function fixture(text: string, maxActiveReviews = 8, workspaceOptions: { caseSensitive?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'edit-session-root-'));
  const state = await mkdtemp(join(tmpdir(), 'edit-session-state-'));
  directories.push(root, state);
  if (text !== '') await writeFile(join(root, 'file.txt'), text);
  const workspace = new FileSystemWorkspaceTextStore(root, workspaceOptions);
  const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
  const manager = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(state),
    new NullLogger(),
    maxActiveReviews,
  );
  return { root, state, workspace, service, manager };
}
