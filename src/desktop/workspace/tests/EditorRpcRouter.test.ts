import { describe, expect, it, vi } from 'vitest';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';

const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'owner' };
describe(EditorRpcRouter, () => {
  it('ignores editor responses from a connection that does not own the operation', async () => {
    const router = new EditorRpcRouter();
    router.connect('owner', identity, vi.fn());
    const completed = vi.fn();
    const result = router
      .request(identity, { type: GlyphEditorRequestType.READ_SNAPSHOT, operationId: 'op', path: 'a.ts' })
      .then(completed);
    router.receive('peer', { operationId: 'op', ok: true });
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    router.receive('owner', { operationId: 'op', ok: true });
    await result;
    expect(completed).toHaveBeenCalledOnce();
  });
  it('rejects outstanding editor work on disconnect and routes new requests to the replacement port', async () => {
    const router = new EditorRpcRouter();
    router.connect('old', identity, vi.fn());
    const result = router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' });
    const rejected = expect(result).rejects.toThrow('disconnected');
    router.disconnect('old');
    await rejected;
    router.connect('new', identity, message => {
      expect(message.type).toBe('glyph_editor_request');
      router.receive('new', { operationId: 'op', ok: true, workingCopies: [] });
    });
    await expect(
      router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' }),
    ).resolves.toMatchObject({ ok: true });
  });
});
