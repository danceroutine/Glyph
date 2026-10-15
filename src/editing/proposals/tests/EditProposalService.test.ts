import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullLogger } from '#src/observability/NullLogger.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { OverlappingWorkspaceFixture } from '#src/workspace/tests/fixtures/OverlappingWorkspaceFixture.js';
import type { EditingConfiguration } from '#src/editing/configuration/EditingConfiguration.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { TextDocument } from '#src/editing/documents/TextDocument.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import { renderEntry, ReviewViewMode } from '#src/terminal/ui/proposal/TerminalEditReviewer.js';

const directories: string[] = [];
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1024 * 1024,
  maxChangedBytes: 1024 * 1024,
  maxResultingBytesPerFile: 1024 * 1024,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 1,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(EditProposalService, () => {
  describe('proposal preflight', () => {
    it.each(['\ud800', '\udc00'].flatMap(path => ['structured', 'patch'].map(format => ({ path, format }))))(
      'rejects malformed Unicode filenames %j in $format proposals before their encoded aliases can be staged',
      async ({ path, format }) => {
        const { service, workspace } = await fixture('base');
        const exists = vi.spyOn(workspace, 'exists');
        expect(Buffer.from(path)).toEqual(Buffer.from('\ufffd'));
        const paths = [path, '\ufffd'];
        const proposal =
          format === 'structured'
            ? service.proposeStructured({ files: paths.map(value => structuredCreate(value)) })
            : service.proposePatch(
                [
                  '*** Begin Patch',
                  ...paths.flatMap(value => [`*** Add File: ${value}`, '+new']),
                  '*** End Patch',
                ].join('\n'),
              );
        await expect(proposal).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
        expect(exists).not.toHaveBeenCalled();
      },
    );

    it('preserves emoji and distinct well-formed Unicode spellings in prospective filenames', async () => {
      const { service } = await fixture('base', {}, { caseSensitive: true });
      const paths = ['🧪.txt', 'é.txt', 'e\u0301.txt', '\ufffd.txt'];
      const proposal = await service.proposeStructured({ files: paths.map(path => structuredCreate(path)) });
      expect(proposal.files.map(file => file.targetPath)).toEqual(paths);
    });

    it.each(
      [
        { paths: ['repo/pkg/a', 'pkg/a'], caseSensitive: true, name: 'duplicate prospective files' },
        { paths: ['repo/pkg/a', 'pkg/a/b'], caseSensitive: true, name: 'physical ancestors' },
        { paths: ['pkg/a/b', 'repo/pkg/a'], caseSensitive: true, name: 'physical ancestors in reverse order' },
        { paths: ['repo/pkg/A', 'pkg/a'], caseSensitive: false, name: 'case-insensitive prospective aliases' },
      ].flatMap(example => ['structured', 'patch'].map(format => ({ ...example, format }))),
    )(
      'rejects $name across overlapping roots in $format proposals before reading sources',
      async ({ paths, caseSensitive, format }) => {
        const base = await fixture('base');
        await mkdir(join(base.workspace.root, 'pkg'));
        const workspace = new OverlappingWorkspaceFixture(base.workspace.root, caseSensitive);
        const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
        const read = vi.spyOn(workspace, 'readOptional');
        const exists = vi.spyOn(workspace, 'exists');
        const pending =
          format === 'structured'
            ? service.proposeStructured({ files: paths.map(path => structuredCreate(path)) })
            : service.proposePatch(
                ['*** Begin Patch', ...paths.flatMap(path => [`*** Add File: ${path}`, '+new']), '*** End Patch'].join(
                  '\n',
                ),
              );
        await expect(pending).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
        expect(read).not.toHaveBeenCalled();
        expect(exists).not.toHaveBeenCalled();
      },
    );

    it.each(['pkg/a', 'pkg/a/b'])('rejects an aliased rename destination %s before source reads', async target => {
      const base = await fixture('base');
      await mkdir(join(base.workspace.root, 'pkg'));
      const workspace = new OverlappingWorkspaceFixture(base.workspace.root);
      const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const read = vi.spyOn(workspace, 'readOptional');
      await expect(
        service.proposeStructured({
          files: [
            structuredCreate('repo/pkg/a'),
            {
              ...structuredCreate('repo/file.txt'),
              operation: EditOperation.RENAME,
              new_path: target,
              base_revision: 'base',
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
    });

    it('allows distinct prospective files and non-segment prefixes across overlapping roots', async () => {
      const base = await fixture('base');
      await mkdir(join(base.workspace.root, 'pkg'));
      const workspace = new OverlappingWorkspaceFixture(base.workspace.root);
      const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const paths = ['repo/pkg/A', 'pkg/a/file', 'pkg/ab', 'repo/other'];
      const proposal = await service.proposeStructured({ files: paths.map(path => structuredCreate(path)) });
      expect(proposal.files.map(file => file.targetPath)).toEqual(paths);
    });

    it.each([
      { paths: ['a', 'a/b'], name: 'a parent before its child' },
      { paths: ['a/b', 'a'], name: 'a child before its parent' },
      { paths: ['dir/a/deep/b', 'dir/a'], name: 'a deeper descendant before its parent' },
      { paths: ['dir/a', 'dir/a/deep/b'], name: 'a parent before its deeper descendant' },
    ])('rejects creating $name before looking up any files', async ({ paths }) => {
      const { service, workspace } = await fixture('base');
      const read = vi.spyOn(workspace, 'readOptional');
      const exists = vi.spyOn(workspace, 'exists');
      await expect(
        service.proposeStructured({ files: paths.map(path => structuredCreate(path)) }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
    });

    it.each([
      { operation: EditOperation.UPDATE, path: 'a/b', new_path: null },
      { operation: EditOperation.DELETE, path: 'a/b', new_path: null },
      { operation: EditOperation.RENAME, path: 'a/b', new_path: 'elsewhere' },
      { operation: EditOperation.RENAME, path: 'elsewhere', new_path: 'a/b' },
    ])('rejects a created ancestor of a $operation source or destination before reading it', async file => {
      const { service, workspace } = await fixture('base');
      const read = vi.spyOn(workspace, 'readOptional');
      const exists = vi.spyOn(workspace, 'exists');
      await expect(
        service.proposeStructured({
          files: [structuredCreate('a'), { ...structuredCreate(file.path), ...file, base_revision: 'base' }],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
    });

    it.each([
      { path: 'a', target: 'a/b' },
      { path: 'a/b', target: 'a' },
    ])('rejects a rename between an ancestor and descendant: $path to $target', async ({ path, target }) => {
      const { service, workspace } = await fixture('base');
      const read = vi.spyOn(workspace, 'readOptional');
      await expect(
        service.proposeStructured({
          files: [
            { ...structuredCreate(path), operation: EditOperation.RENAME, new_path: target, base_revision: 'base' },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
    });

    it('rejects differently cased ancestors on case-insensitive workspaces', async () => {
      const { service, workspace } = await fixture('base', {}, { caseSensitive: false });
      const exists = vi.spyOn(workspace, 'exists');
      await expect(
        service.proposeStructured({ files: [structuredCreate('Folder'), structuredCreate('folder/file')] }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(exists).not.toHaveBeenCalled();
    });

    it('allows sibling paths, non-segment prefixes, and distinct casing on case-sensitive workspaces', async () => {
      const { service } = await fixture('base', {}, { caseSensitive: true });
      const paths = ['Folder', 'folder/file', 'folder/other', 'folders'];
      const proposal = await service.proposeStructured({ files: paths.map(path => structuredCreate(path)) });
      expect(proposal.files.map(file => file.targetPath)).toEqual(paths);
    });

    it.each(['Add', 'Update', 'Delete', 'Rename'])(
      'rejects an oversized %s patch before any source or occupancy reads',
      async operation => {
        const { service, workspace } = await fixture('base\n');
        const base = await workspace.read('file.txt');
        const read = vi.spyOn(workspace, 'readOptional').mockResolvedValue(base);
        const exists = vi.spyOn(workspace, 'exists').mockResolvedValue(false);
        const header = operation === 'Rename' ? 'Update' : operation;
        const entries = Array.from({ length: 1_000 }, (_, index) => [
          `*** ${header} File: source-${index}`,
          ...(operation === 'Add' ? ['+next'] : [`*** Revision: ${base.revision}`]),
          ...(operation === 'Rename' ? [`*** Move to: target-${index}`] : []),
          ...(['Update', 'Rename'].includes(operation) ? ['@@', '-base', '+next'] : []),
        ]).flat();
        const patch = ['*** Begin Patch', ...entries, '*** End Patch'].join('\n');
        expect(Buffer.byteLength(patch)).toBeLessThan(configuration.maxRawProposalBytes);
        await expect(service.proposePatch(patch)).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
        expect(read).not.toHaveBeenCalled();
        expect(exists).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: 'an updated descendant after a created file',
        entries: ['*** Add File: a', '+new', '*** Update File: a/b', '*** Revision: base', '@@', '-base', '+next'],
      },
      {
        name: 'an updated descendant before a created file',
        entries: ['*** Update File: a/b', '*** Revision: base', '@@', '-base', '+next', '*** Add File: a', '+new'],
      },
      {
        name: 'a rename destination under another created file',
        entries: [
          '*** Update File: original',
          '*** Revision: base',
          '*** Move to: a/b',
          '@@',
          '-base',
          '+next',
          '*** Add File: a',
          '+new',
        ],
      },
      {
        name: 'a created descendant depending on a prior file deletion',
        entries: ['*** Delete File: a', '*** Revision: base', '*** Add File: a/b', '+new'],
      },
      {
        name: 'a duplicate deletion',
        entries: ['*** Delete File: a', '*** Revision: base', '*** Delete File: a', '*** Revision: base'],
      },
    ])('rejects $name before expanding patch source content', async ({ entries }) => {
      const { service, workspace } = await fixture('base');
      const read = vi.spyOn(workspace, 'readOptional');
      const exists = vi.spyOn(workspace, 'exists');
      await expect(
        service.proposePatch(['*** Begin Patch', ...entries, '*** End Patch'].join('\n')),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
    });

    it('rejects conflicting rename destinations before reading either source', async () => {
      const { service, workspace } = await fixture('base');
      const read = vi.spyOn(workspace, 'readOptional');
      await expect(
        service.proposeStructured({
          files: ['a', 'a/b'].map((target, index) => ({
            ...structuredCreate(`source-${index}`),
            operation: EditOperation.RENAME,
            new_path: target,
            base_revision: 'base',
          })),
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      expect(read).not.toHaveBeenCalled();
    });

    it('compiles a patch at the exact file-count limit with unrelated sources and destinations', async () => {
      const { service, workspace } = await fixture('base\n', { maxFiles: 2 });
      const base = await workspace.read('file.txt');
      const proposal = await service.proposePatch(
        [
          '*** Begin Patch',
          '*** Update File: file.txt',
          `*** Revision: ${base.revision}`,
          '*** Move to: renamed.txt',
          '@@',
          '-base',
          '+next',
          '*** Add File: nested/new.txt',
          '+new',
          '*** End Patch',
        ].join('\n'),
      );
      expect(proposal.files.map(file => file.targetPath)).toEqual(['renamed.txt', 'nested/new.txt']);
    });
  });

  it('tokenizes patch source once and composes all hunks without recopying the full file', async () => {
    const lines = Array.from({ length: 128 }, (_, index) => `line${String(index).padStart(4, '0')}${'x'.repeat(119)}`);
    const text = lines.join('\n') + '\n';
    const { service, workspace } = await fixture(text);
    const base = await workspace.read('file.txt');
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      `*** Revision: ${base.revision}`,
      ...lines.flatMap(line => ['@@', `-${line}`, `+${line.replace('line', 'LINE')}`]),
      '*** End Patch',
    ].join('\n');
    const originalSlice = String.prototype.slice;
    let copiedCharacters = 0;
    const slice = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start?: number,
      end?: number,
    ) {
      const result = originalSlice.call(this, start, end);
      if (this.length === text.length) copiedCharacters += result.length;
      return result;
    });
    try {
      const proposal = await service.proposePatch(patch);
      expect(proposal.files[0]!.proposed.text).toBe(text.replaceAll('line', 'LINE'));
      expect(proposal.files[0]!.items).toHaveLength(1);
    } finally {
      slice.mockRestore();
    }
    expect(copiedCharacters).toBeLessThanOrEqual(text.length * 2);
  });

  it('compiles a thousand small ranged edits in a 512 KiB file using one source index and one review hunk', async () => {
    const { service, workspace } = await fixture('x'.repeat(512 * 1024));
    const base = await workspace.read('file.txt');
    const edits = Array.from({ length: 1_000 }, (_, index) => ({
      range: {
        start: { line: 0, character: index * 512 },
        end: { line: 0, character: index * 512 + 1 },
      },
      expected_text: 'x',
      replacement_text: 'y',
    }));
    const input = {
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: base.revision,
          content: null,
          byte_order_mark: null,
          edits,
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(configuration.maxRawProposalBytes);
    const index = vi.spyOn(
      TextDocument.prototype as unknown as { lineRanges(): { start: number; end: number }[] },
      'lineRanges',
    );
    try {
      const proposal = await service.proposeStructured(input);
      expect(index).toHaveBeenCalledTimes(1);
      const file = proposal.files[0]!;
      expect(file.items).toHaveLength(1);
      expect(file.proposed.text).toBe(('y' + 'x'.repeat(511)).repeat(1_000) + 'x'.repeat(512 * 24));
      expect(file.proposed.byteLength).toBe(base.byteLength);
    } finally {
      index.mockRestore();
    }
  });

  it('allows removing a BOM from an empty file even when the resulting and changed-text budgets are one byte', async () => {
    const { service, workspace } = await fixture('', { maxResultingBytesPerFile: 1, maxChangedBytes: 1 });
    await writeFile(join(workspace.root, 'file.txt'), Buffer.from([0xef, 0xbb, 0xbf]));
    const base = await workspace.read('file.txt');
    await expect(
      service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: '',
            byte_order_mark: false,
            edits: [],
          },
        ],
      }),
    ).resolves.toMatchObject({ files: [{ proposed: { byteOrderMark: false, byteLength: 0 } }] });
  });
  it.each(['large text', 'binary', 'directory'])(
    'rejects a CREATE collision with %s without reading its contents',
    async kind => {
      const { service, workspace } = await fixture('base');
      const path = 'occupied.txt';
      if (kind === 'directory') await mkdir(join(workspace.root, path));
      else
        await writeFile(
          join(workspace.root, path),
          kind === 'binary' ? Buffer.from([0, 255]) : 'x'.repeat(2 * 1024 * 1024),
        );
      const read = vi.spyOn(workspace, 'read');
      await expect(
        service.proposeStructured({
          files: [
            {
              operation: EditOperation.CREATE,
              path,
              new_path: null,
              base_revision: null,
              content: 'new',
              byte_order_mark: false,
              edits: [],
            },
          ],
        }),
      ).rejects.toMatchObject({ message: 'Create target already exists.' });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('rejects a RENAME collision without loading destination content', async () => {
    const { service, workspace } = await fixture('base');
    const base = await workspace.read('file.txt');
    await writeFile(join(workspace.root, 'occupied.txt'), 'x'.repeat(2 * 1024 * 1024));
    const read = vi.spyOn(workspace, 'read');
    await expect(
      service.proposeStructured({
        files: [
          {
            operation: EditOperation.RENAME,
            path: 'file.txt',
            new_path: 'occupied.txt',
            base_revision: base.revision,
            content: null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ message: 'Rename target already exists.' });
    expect(read.mock.calls.some(([path]) => path === 'occupied.txt')).toBe(false);
  });

  it.each([EditOperation.UPDATE, EditOperation.DELETE, EditOperation.RENAME])(
    'bounds structured %s source reads before loading or diffing oversized files',
    async operation => {
      const { service, workspace } = await fixture('x'.repeat(20), { maxResultingBytesPerFile: 8, maxChangedBytes: 8 });
      const base = await workspace.read('file.txt');
      const read = vi.spyOn(workspace, 'read');
      await expect(
        service.proposeStructured({
          files: [
            {
              operation,
              path: 'file.txt',
              new_path: operation === EditOperation.RENAME ? 'renamed.txt' : null,
              base_revision: base.revision,
              content: operation === EditOperation.UPDATE ? 'small' : null,
              byte_order_mark: null,
              edits: [],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
      expect(read).toHaveBeenCalledWith('file.txt', { maxBytes: 19 });
    },
  );

  it('bounds patch source reads before matching hunks', async () => {
    const { service, workspace } = await fixture('x'.repeat(20), { maxResultingBytesPerFile: 8, maxChangedBytes: 8 });
    const base = await workspace.read('file.txt');
    const read = vi.spyOn(workspace, 'read');
    await expect(
      service.proposePatch(`*** Begin Patch\n*** Delete File: file.txt\n*** Revision: ${base.revision}\n*** End Patch`),
    ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
    expect(read).toHaveBeenCalledWith('file.txt', { maxBytes: 19 });
  });

  it('stops diff computation at its deadline instead of measuring only after completion', async () => {
    const base = Array.from({ length: 100 }, (_, index) => `old ${index}\n`).join('');
    const content = Array.from({ length: 100 }, (_, index) => `new ${index}\n`).join('');
    const { service, workspace } = await fixture(base, { diffBudgetMs: 10 });
    const snapshot = await workspace.read('file.txt');
    let time = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (time += 20));
    try {
      await expect(
        service.proposeStructured({
          files: [
            {
              operation: EditOperation.UPDATE,
              path: 'file.txt',
              new_path: null,
              base_revision: snapshot.revision,
              content,
              byte_order_mark: false,
              edits: [],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects an oversized replacement before spending work on its diff', async () => {
    const { service, workspace } = await fixture('base', { maxResultingBytesPerFile: 4 });
    const snapshot = await workspace.read('file.txt');
    const diff = vi.spyOn(JsDiffTextDiffer.prototype, 'createReviewItems');
    try {
      await expect(
        service.proposeStructured({
          files: [
            {
              operation: EditOperation.UPDATE,
              path: 'file.txt',
              new_path: null,
              base_revision: snapshot.revision,
              content: 'too large',
              byte_order_mark: false,
              edits: [],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
      expect(diff).not.toHaveBeenCalled();
    } finally {
      diff.mockRestore();
    }
  });

  it.each(
    [EditOperation.CREATE, EditOperation.UPDATE].flatMap(operation =>
      [
        { label: 'NUL', content: 'invalid\0text' },
        { label: 'an unpaired high surrogate', content: '\ud800' },
        { label: 'an unpaired low surrogate', content: '\udc00' },
      ].map(value => ({ operation, ...value })),
    ),
  )('rejects $label while compiling $operation before staging a review', async ({ operation, content }) => {
    const { service, workspace } = await fixture('base');
    const base = await workspace.read('file.txt');
    await expect(
      service.proposeStructured({
        files: [
          {
            operation,
            path: operation === EditOperation.CREATE ? 'new.txt' : 'file.txt',
            new_path: null,
            base_revision: operation === EditOperation.CREATE ? null : base.revision,
            content,
            byte_order_mark: false,
            edits: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
  });

  it.each([
    { base: '', content: '', bom: true, marker: 'Encoding: UTF-8 → UTF-8 with BOM' },
    { base: '\uFEFFbody', content: 'body', bom: false, marker: 'Encoding: UTF-8 with BOM → UTF-8' },
    { base: 'body', content: '\u001b[31mbody\u001b[0m', bom: false, marker: '␛[31mbody␛[0m' },
    { base: 'body', content: '\uFEFFbody', bom: false, marker: '⟨U+FEFF⟩body' },
  ])('makes byte-level changes visible in a compiled review: $marker', async ({ base, content, bom, marker }) => {
    const { service, workspace } = await fixture(base);
    const snapshot = await workspace.read('file.txt');
    const proposal = await service.proposeStructured({
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: snapshot.revision,
          content,
          byte_order_mark: bom,
          edits: [],
        },
      ],
    });
    const file = proposal.files[0]!;
    const rendered = renderEntry(file, file.items[0]!, ReviewViewMode.FULL_FILE, false).lines.join('\n');
    expect(rendered).toContain(marker);
    expect(rendered).not.toContain('\u001b');
    if (snapshot.text === content) expect(rendered).toContain('Text content unchanged');
    expect(file.proposed.text).toBe(content);
  });

  it('retains a BOM-only change as a separate decision when renaming identical text', async () => {
    const { service, workspace } = await fixture('same\n');
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
    expect(proposal.files[0]?.items.map(item => item.kind)).toEqual([
      EditReviewItemKind.RENAME,
      EditReviewItemKind.TEXT,
    ]);
  });
  it('locates patch hunks in the original base even when an earlier replacement duplicates later context', async () => {
    const { service, workspace } = await fixture('left\nseparator\nright\n');
    const base = await workspace.read('file.txt');
    const proposal = await service.proposePatch(
      `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${base.revision}\n@@\n-left\n+right\n@@\n-right\n+last\n*** End Patch`,
    );
    expect(proposal.files[0]?.proposed.text).toBe('right\nseparator\nlast\n');
  });

  describe(EditProposalService.prototype.proposeStructured, () => {
    it('applies unsorted zero-based UTF-16 edits against the unchanged base without normalizing text', async () => {
      const { service, workspace } = await fixture('a😀b\r\nmiddle\r\nlast');
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
                range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
                expected_text: '',
                replacement_text: '!',
              },
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                expected_text: 'a',
                replacement_text: 'A',
              },
            ],
          },
        ],
      });

      expect(proposal.files[0]?.proposed.text).toBe('A😀b\r\nmiddle\r\nlast!');
      expect(proposal.files[0]?.items).toHaveLength(2);
    });

    it('rejects a range that splits an emoji surrogate pair', async () => {
      const { service, workspace } = await fixture('a😀b');
      const base = await workspace.read('file.txt');
      await expect(
        service.proposeStructured({
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
                  range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
                  expected_text: '',
                  replacement_text: 'x',
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.INCONSISTENT });
    });

    it('rejects overlapping edits, duplicate insertions, no-ops, and stale revisions', async () => {
      const { service, workspace } = await fixture('abcdef');
      const base = await workspace.read('file.txt');
      const file = {
        operation: EditOperation.UPDATE,
        path: 'file.txt',
        new_path: null,
        base_revision: base.revision,
        content: null,
        byte_order_mark: null,
      };
      await expect(
        service.proposeStructured({
          files: [
            {
              ...file,
              edits: [
                {
                  range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
                  expected_text: 'bcd',
                  replacement_text: 'x',
                },
                {
                  range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
                  expected_text: 'de',
                  replacement_text: 'y',
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS });
      await expect(service.proposeStructured({ files: [{ ...file, edits: [] }] })).rejects.toMatchObject({
        reason: EditFailureReason.EMPTY,
      });
      await expect(
        service.proposeStructured({ files: [{ ...file, base_revision: 'wrong', edits: [] }] }),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    });

    it('enforces file, hunk, and changed-byte limits at their boundaries', async () => {
      const exact = await fixture('one\nmiddle\nthree\n', {
        maxFiles: 1,
        maxHunksPerFile: 1,
        maxTotalHunks: 1,
        maxChangedBytes: 8,
      });
      const base = await exact.workspace.read('file.txt');
      const oneChange = {
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
            ],
          },
        ],
      };
      await expect(exact.service.proposeStructured(oneChange)).resolves.toBeDefined();

      const changedExceeded = await fixture('one\nmiddle\nthree\n', { maxChangedBytes: 7 });
      const changedBase = await changedExceeded.workspace.read('file.txt');
      await expect(
        changedExceeded.service.proposeStructured({
          files: [{ ...oneChange.files[0]!, base_revision: changedBase.revision }],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });

      const hunkExceeded = await fixture('one\nmiddle\nthree\n', { maxHunksPerFile: 1 });
      const hunkBase = await hunkExceeded.workspace.read('file.txt');
      await expect(
        hunkExceeded.service.proposeStructured({
          files: [
            {
              ...oneChange.files[0]!,
              base_revision: hunkBase.revision,
              edits: [
                ...oneChange.files[0]!.edits,
                {
                  range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
                  expected_text: 'three',
                  replacement_text: 'THREE',
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });

      const fileExceeded = await fixture('one', { maxFiles: 1 });
      const fileBase = await fileExceeded.workspace.read('file.txt');
      await expect(
        fileExceeded.service.proposeStructured({
          files: [
            {
              operation: EditOperation.UPDATE,
              path: 'file.txt',
              new_path: null,
              base_revision: fileBase.revision,
              content: 'ONE',
              byte_order_mark: null,
              edits: [],
            },
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
        }),
      ).rejects.toMatchObject({ reason: EditFailureReason.LIMIT_EXCEEDED });
    });
  });

  describe(EditProposalService.prototype.proposePatch, () => {
    it('stops expensive partial-context matching inside its time budget', async () => {
      const { service, workspace } = await fixture('same\n'.repeat(200), { diffBudgetMs: 20 });
      const base = await workspace.read('file.txt');
      const patch = [
        '*** Begin Patch',
        '*** Update File: file.txt',
        `*** Revision: ${base.revision}`,
        '@@',
        ...Array.from({ length: 100 }, () => ' same'),
        '-missing',
        '+replacement',
        '*** End Patch',
      ].join('\n');
      let time = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => ++time);
      try {
        await expect(service.proposePatch(patch)).rejects.toMatchObject({
          reason: EditFailureReason.LIMIT_EXCEEDED,
          message: 'Patch matching exceeded the configured time budget.',
        });
      } finally {
        clock.mockRestore();
      }
    });

    it('shares one matching deadline across every hunk in a file', async () => {
      const lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
      const { service, workspace } = await fixture(lines.join('\n') + '\n', { diffBudgetMs: 15 });
      const base = await workspace.read('file.txt');
      const patch = [
        '*** Begin Patch',
        '*** Update File: file.txt',
        `*** Revision: ${base.revision}`,
        ...lines.flatMap(line => ['@@', `-${line}`, `+changed-${line}`]),
        '*** End Patch',
      ].join('\n');
      let time = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => ++time);
      try {
        await expect(service.proposePatch(patch)).rejects.toMatchObject({
          reason: EditFailureReason.LIMIT_EXCEEDED,
          message: 'Patch matching exceeded the configured time budget.',
        });
      } finally {
        clock.mockRestore();
      }
    });

    it('checks cancellation during a long contextual match', async () => {
      const { service, workspace } = await fixture('same\n'.repeat(200));
      const base = await workspace.read('file.txt');
      const patch = [
        '*** Begin Patch',
        '*** Update File: file.txt',
        `*** Revision: ${base.revision}`,
        '@@',
        ...Array.from({ length: 100 }, () => ' same'),
        '-missing',
        '+replacement',
        '*** End Patch',
      ].join('\n');
      const controller = new AbortController();
      const cancellation = new Error('Cancelled during patch matching.');
      let checks = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
        if (++checks === 12) controller.abort(cancellation);
        return 0;
      });
      try {
        await expect(service.proposePatch(patch, controller.signal)).rejects.toBe(cancellation);
      } finally {
        clock.mockRestore();
      }
    });

    it('composes out-of-order hunks while preserving untouched mixed line endings and the BOM', async () => {
      const { service, workspace } = await fixture('\uFEFFalpha\r\nbeta\rgamma\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposePatch(
        [
          '*** Begin Patch',
          '*** Update File: file.txt',
          `*** Revision: ${base.revision}`,
          '*** Line Ending: LF',
          '@@',
          '-gamma',
          '+GAMMA',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** End Patch',
        ].join('\n'),
      );
      expect(proposal.files[0]!.proposed).toMatchObject({ text: 'ALPHA\nbeta\rGAMMA\n', byteOrderMark: true });
    });

    it('rejects overlapping contextual hunks before composing their replacements', async () => {
      const { service, workspace } = await fixture('a\nb\nc\n');
      const base = await workspace.read('file.txt');
      await expect(
        service.proposePatch(
          [
            '*** Begin Patch',
            '*** Update File: file.txt',
            `*** Revision: ${base.revision}`,
            '@@',
            ' a',
            '-b',
            '+B',
            '@@',
            '-b',
            '+B',
            ' c',
            '*** End Patch',
          ].join('\n'),
        ),
      ).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Patch hunks overlap in the base file.',
      });
    });

    it('compiles a strict contextual patch to the same proposed bytes as structured edits', async () => {
      const { service, workspace } = await fixture('one\ntwo\nthree\n');
      const base = await workspace.read('file.txt');
      const proposal = await service.proposePatch(
        `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${base.revision}\n@@\n one\n-two\n+TWO\n three\n*** End Patch`,
      );

      expect(proposal.files[0]?.proposed.text).toBe('one\nTWO\nthree\n');
    });

    it.each([
      {
        name: 'whole-line deletion',
        base: 'alpha\nbeta\ngamma\n',
        patch: ' alpha\n-beta\n gamma',
        edit: {
          range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
          expected_text: 'beta\n',
          replacement_text: '',
        },
      },
      {
        name: 'whole-line insertion',
        base: 'alpha\ngamma\n',
        patch: ' alpha\n+beta\n gamma',
        edit: {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
          expected_text: '',
          replacement_text: 'beta\n',
        },
      },
      {
        name: 'insertion at EOF without a final newline',
        base: 'alpha',
        patch: ' alpha\n+omega',
        edit: {
          range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
          expected_text: '',
          replacement_text: '\nomega',
        },
      },
    ])('is byte-equivalent to a structured $name', async ({ base: text, patch, edit }) => {
      const { service, workspace } = await fixture(text);
      const base = await workspace.read('file.txt');
      const [patchProposal, structuredProposal] = await Promise.all([
        service.proposePatch(
          `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${base.revision}\n@@\n${patch}\n*** End Patch`,
        ),
        service.proposeStructured({
          files: [
            {
              operation: EditOperation.UPDATE,
              path: 'file.txt',
              new_path: null,
              base_revision: base.revision,
              content: null,
              byte_order_mark: null,
              edits: [edit],
            },
          ],
        }),
      ]);

      expect(patchProposal.files[0]?.proposed.text).toBe(structuredProposal.files[0]?.proposed.text);
      expect(patchProposal.files[0]?.proposed.revision).toBe(structuredProposal.files[0]?.proposed.revision);
    });

    it('accepts one final line ending after the end delimiter', async () => {
      const { service } = await fixture('base');

      await expect(
        service.proposePatch('*** Begin Patch\n*** Add File: lf.txt\n+content\n*** End Patch\n'),
      ).resolves.toMatchObject({ files: [{ targetPath: 'lf.txt' }] });
      await expect(
        service.proposePatch('*** Begin Patch\r\n*** Add File: crlf.txt\r\n+content\r\n*** End Patch\r\n'),
      ).resolves.toMatchObject({ files: [{ targetPath: 'crlf.txt' }] });
      await expect(
        service.proposePatch('*** Begin Patch\n*** Add File: extra.txt\n+content\n*** End Patch\n\n'),
      ).rejects.toMatchObject({ reason: EditFailureReason.MALFORMED });
    });

    it('rejects repeated contextual matches as ambiguous and reports candidate lines', async () => {
      const { service, workspace } = await fixture('same\nsame\n');
      const base = await workspace.read('file.txt');
      await expect(
        service.proposePatch(
          `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${base.revision}\n@@\n-same\n+changed\n*** End Patch`,
        ),
      ).rejects.toMatchObject({
        reason: EditFailureReason.AMBIGUOUS,
        details: { candidates: [1, 2] },
      });
    });

    it('reports two ambiguity witnesses without allocating every repeated contextual match', async () => {
      const { service, workspace } = await fixture('same\n'.repeat(200));
      const base = await workspace.read('file.txt');
      await expect(
        service.proposePatch(
          [
            '*** Begin Patch',
            '*** Update File: file.txt',
            `*** Revision: ${base.revision}`,
            '@@',
            ...Array.from({ length: 49 }, () => ' same'),
            '-same',
            '+changed',
            '*** End Patch',
          ].join('\n'),
        ),
      ).rejects.toMatchObject({ reason: EditFailureReason.AMBIGUOUS, details: { candidates: [1, 2] } });
    });

    it('enforces exact raw and resulting-byte boundaries', async () => {
      const patch = '*** Begin Patch\n*** Add File: new.txt\n+x\n*** End Patch';
      const rawBytes = Buffer.byteLength(patch);
      const exact = await fixture('', { maxRawProposalBytes: rawBytes, maxResultingBytesPerFile: 2 });
      await expect(exact.service.proposePatch(patch)).resolves.toMatchObject({
        files: [{ proposed: { byteLength: 2 } }],
      });
      const rawExceeded = await fixture('', { maxRawProposalBytes: rawBytes - 1 });
      await expect(rawExceeded.service.proposePatch(patch)).rejects.toMatchObject({
        reason: EditFailureReason.LIMIT_EXCEEDED,
      });
      const resultExceeded = await fixture('', { maxResultingBytesPerFile: 1 });
      await expect(resultExceeded.service.proposePatch(patch)).rejects.toMatchObject({
        reason: EditFailureReason.LIMIT_EXCEEDED,
      });
    });

    it('rejects every unrecognized directive and a missing required revision', async () => {
      const { service } = await fixture('base');
      await expect(
        service.proposePatch('*** Begin Patch\n*** Frobnicate: file.txt\n*** End Patch'),
      ).rejects.toMatchObject({ reason: EditFailureReason.MALFORMED });
      await expect(
        service.proposePatch('*** Begin Patch\n*** Update File: file.txt\n@@\n-base\n+next\n*** End Patch'),
      ).rejects.toMatchObject({ reason: EditFailureReason.MALFORMED });
    });
  });
});

async function fixture(
  text: string,
  overrides: Partial<EditingConfiguration> = {},
  workspaceOptions: { caseSensitive?: boolean } = {},
): Promise<{ service: EditProposalService; workspace: FileSystemWorkspaceTextStore }> {
  const root = await mkdtemp(join(tmpdir(), 'proposal-service-'));
  directories.push(root);
  await writeFile(join(root, 'file.txt'), text);
  const workspace = new FileSystemWorkspaceTextStore(root, workspaceOptions);
  return {
    workspace,
    service: new EditProposalService(
      workspace,
      new JsDiffTextDiffer(),
      { ...configuration, ...overrides },
      new NullLogger(),
      () => `id-${Math.random()}`,
      () => new Date(0),
    ),
  };
}

function structuredCreate(path: string) {
  return {
    operation: EditOperation.CREATE,
    path,
    new_path: null,
    base_revision: null,
    content: 'new',
    byte_order_mark: false,
    edits: [],
  };
}
