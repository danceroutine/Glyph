import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { GlyphFileMutationKind } from '#src/desktop/protocol/editor/GlyphFileMutation.js';

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

  describe(EditorRpcRouter.prototype.disconnect, () => {
    it('leaves other connections and their pending work intact', async () => {
      const router = new EditorRpcRouter();
      const other = { profileId: 'profile', workspaceId: 'workspace', windowId: 'other' };
      router.connect('owner', identity, vi.fn());
      router.connect('other', other, vi.fn());
      const result = router.request(other, { type: GlyphEditorRequestType.EXISTS, operationId: 'op', path: 'a.ts' });
      router.disconnect('owner');
      router.receive('other', { operationId: 'op', ok: true, exists: true });
      await expect(result).resolves.toEqual({ operationId: 'op', ok: true, exists: true });
      await expect(
        router.request(identity, { type: GlyphEditorRequestType.EXISTS, operationId: 'next', path: 'a.ts' }),
      ).rejects.toThrow('The owning editor is unavailable.');
    });
  });

  describe(EditorRpcRouter.prototype.request, () => {
    it('rejects when no editor is connected for the identity', async () => {
      const router = new EditorRpcRouter();
      await expect(
        router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS, operationId: 'op' }),
      ).rejects.toThrow('The owning editor is unavailable.');
    });

    it('identifies mutations by their operation and refuses a duplicate while one is pending', async () => {
      const router = new EditorRpcRouter();
      const send = vi.fn();
      router.connect('owner', identity, send);
      const mutation = {
        operationId: 'mutation',
        undoGroupId: 'group',
        path: 'a.ts',
        kind: GlyphFileMutationKind.CREATE,
        text: 'new',
        byteOrderMark: false,
      } as const;
      const first = router.request(identity, { type: GlyphEditorRequestType.APPLY_FILE_MUTATION, mutation });
      await expect(
        router.request(identity, {
          type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
          mutation: {
            operationId: 'mutation',
            path: 'a.ts',
            expectedContentRevision: 'r1',
            expectedToken: { workspaceGeneration: 'g', resource: 'file:///a.ts', incarnation: 'i', version: 1 },
            text: 'text',
            byteOrderMark: false,
            undoGroupId: 'group',
          },
        }),
      ).rejects.toThrow('This editor operation is already pending.');
      router.receive('owner', { operationId: 'mutation', ok: true });
      await expect(first).resolves.toEqual({ operationId: 'mutation', ok: true });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        type: 'glyph_editor_request',
        request: { type: GlyphEditorRequestType.APPLY_FILE_MUTATION, mutation },
      });
    });

    it('throws immediately when the caller has already cancelled', () => {
      const router = new EditorRpcRouter();
      const send = vi.fn();
      router.connect('owner', identity, send);
      const controller = new AbortController();
      controller.abort(new Error('Stopped early'));
      expect(() =>
        router.request(
          identity,
          { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' },
          controller.signal,
        ),
      ).toThrow('Stopped early');
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects and frees the operation when the caller cancels', async () => {
      const router = new EditorRpcRouter();
      router.connect('owner', identity, vi.fn());
      const controller = new AbortController();
      const result = router.request(
        identity,
        { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' },
        controller.signal,
      );
      controller.abort();
      await expect(result).rejects.toThrow('The editor operation was cancelled.');
      const retry = router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' });
      router.receive('owner', { operationId: 'op', ok: true });
      await expect(retry).resolves.toEqual({ operationId: 'op', ok: true });
    });

    it('rejects when the editor does not answer within thirty seconds', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const router = new EditorRpcRouter();
      router.connect('owner', identity, vi.fn());
      const result = router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' });
      const rejected = expect(result).rejects.toThrow(
        'The editor operation timed out; its outcome must be inspected before retrying.',
      );
      await vi.advanceTimersByTimeAsync(29_999);
      router.receive('peer', { operationId: 'op', ok: true });
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    });

    it('rejects with the delivery failure when the port cannot send', async () => {
      const router = new EditorRpcRouter();
      router.connect('owner', identity, () => {
        throw new Error('Port closed');
      });
      await expect(
        router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' }),
      ).rejects.toThrow('Port closed');
    });

    it('wraps non-error delivery failures', async () => {
      const router = new EditorRpcRouter();
      router.connect('owner', identity, () => {
        throw 'detached';
      });
      await expect(
        router.request(identity, { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'op' }),
      ).rejects.toThrow('detached');
    });
  });
});
