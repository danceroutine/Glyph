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
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';

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
  it.each(['\ud800', '\udc00'])(
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
      first: 'caf\u00e9.txt',
      second: 'cafe\u0301.txt',
      alias: false,
    },
    {
      label: 'rejects real filesystem aliases during compilation and batch acceptance before any write',
      first: 'caf\u00e9.txt',
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
        if (combined) await manager.stage({ ...proposals[0]!, files: proposals.flatMap(proposal => proposal.files) });
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
});

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
