import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import { ContextAttachmentFailureReason } from '#src/context/attachments/ContextAttachmentFailureReason.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

describe('Workspace read budgets', () => {
  it.each(['line-range read', 'attachment'] as const)(
    '[review-09] rejects an oversized %s before an unbounded file read, decode, or hash',
    async operation => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-read-budget-'));
      try {
        await mkdir(join(root, 'data'));
        // A tiny file over a tiny configured limit proves ordering without an
        // enormous allocation, sparse-file trick, or actual memory exhaustion.
        await writeFile(join(root, 'data', 'large.txt'), 'first line\n' + 'x'.repeat(128));
        vi.mocked(readFile).mockClear();
        const workspace = new FileSystemWorkspaceTextStore(root);
        if (operation === 'line-range read') {
          const access = new ProjectAccess(root, { maxFileBytes: 32 }, workspace);
          const result = JSON.parse(
            await access.execute(
              'read_project_file',
              JSON.stringify({
                path: 'data/large.txt',
                start_line: 1,
                end_line: 1,
              }),
            ),
          );
          expect(result.error).toMatchObject({ message: expect.stringMatching(/32-byte.*limit/) });
        } else {
          const attachments = new ContextAttachmentService(workspace, { maxFileBytes: 32 });
          await expect(attachments.resolve([{ path: 'data/large.txt' }])).rejects.toMatchObject({
            reason: ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED,
          });
        }
        expect(readFile).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
