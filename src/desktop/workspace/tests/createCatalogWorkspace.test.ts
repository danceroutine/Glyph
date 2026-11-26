import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { it, expect, vi, onTestFinished } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { createCatalogWorkspace } from '#src/desktop/workspace/createCatalogWorkspace.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-catalog-read-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'AGENTS.md'), 'Disk');
  const disk = new FileSystemWorkspaceTextStore(root);
  const request = vi.fn(async (): Promise<GlyphEditorResponse> => ({ operationId: 'read', ok: true }));
  const workspace = createCatalogWorkspace(disk, disk, request);
  return { root, disk, request, workspace };
}
it('uses authorized disk snapshots without asking the editor to open or retain a model', async () => {
  const { disk, request, workspace } = await fixture();
  expect(await workspace.read('AGENTS.md')).toEqual(await disk.read('AGENTS.md'));
  expect(request.mock.calls).toHaveLength(1);
  expect(await workspace.readOptional('missing')).toBeUndefined();
  await expect(workspace.read('missing')).rejects.toThrow();
  expect(request.mock.calls).toHaveLength(1);
});
it('preserves dirty text while retaining the verified physical file identity and permissions', async () => {
  const { disk, request, workspace } = await fixture();
  const file = await disk.read('AGENTS.md');
  request.mockResolvedValue({
    operationId: 'read',
    ok: true,
    snapshot: {
      uri: 'file:///project/AGENTS.md',
      path: 'AGENTS.md',
      text: 'Unsaved',
      byteOrderMark: true,
      contentRevision: 'dirty-revision',
      byteLength: 10,
      mode: 0o644,
      identity: 'editor',
      dirty: true,
      token: { workspaceGeneration: 'g', resource: 'r', incarnation: 'i', version: 1 },
    },
  });
  expect(await workspace.read('./AGENTS.md', { maxBytes: 64 })).toEqual({
    ...file,
    text: 'Unsaved',
    byteOrderMark: true,
    revision: 'dirty-revision',
    byteLength: 10,
  });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: 'AGENTS.md', maxBytes: 64 }));
  request.mockResolvedValue({
    operationId: 'read',
    ok: true,
    snapshot: { ...(await request()).snapshot!, path: 'wrong' },
  });
  await expect(workspace.read('AGENTS.md')).rejects.toThrow('invalid catalog');
});
it.each([false, true])(
  'rejects changed filesystem bytes or identity during an editor RPC (replace=%s)',
  async replace => {
    const { root, request, workspace } = await fixture();
    request.mockImplementation(async () => {
      if (replace) {
        await rename(join(root, 'AGENTS.md'), join(root, 'old'));
        await writeFile(join(root, 'AGENTS.md'), 'Disk');
      } else await writeFile(join(root, 'AGENTS.md'), 'Changed');
      return { operationId: 'read', ok: true };
    });
    await expect(workspace.read('AGENTS.md')).rejects.toThrow('changed during');
  },
);
it.each([undefined, 'Editor unavailable'])('fails closed on editor errors (%s)', async message => {
  const { request, workspace } = await fixture();
  request.mockResolvedValue({
    operationId: 'read',
    ok: false,
    ...(message ? { error: { code: GlyphDesktopErrorCode.HOST_UNAVAILABLE, message, retryable: true } } : {}),
  });
  await expect(workspace.read('AGENTS.md')).rejects.toThrow(message ?? 'catalog snapshot is unavailable');
});
