import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '../../../observability/NullLogger.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import type { EditingConfiguration } from '../../configuration/EditingConfiguration.ts';
import { JsDiffTextDiffer } from '../../documents/JsDiffTextDiffer.ts';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { EditOperation } from '../EditOperation.ts';
import { EditProposalService } from '../EditProposalService.ts';

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
  describe(EditProposalService.prototype.proposeStructured, () => {
    it('applies zero-based UTF-16 edits in reverse source order without normalizing text', async () => {
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
): Promise<{ service: EditProposalService; workspace: FileSystemWorkspaceTextStore }> {
  const root = await mkdtemp(join(tmpdir(), 'proposal-service-'));
  directories.push(root);
  await writeFile(join(root, 'file.txt'), text);
  const workspace = new FileSystemWorkspaceTextStore(root);
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
