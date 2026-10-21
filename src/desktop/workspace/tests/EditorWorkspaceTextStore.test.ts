import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import type { GlyphEditorTextSnapshot } from '#src/desktop/protocol/editor/GlyphEditorTextSnapshot.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { GlyphFileMutationKind } from '#src/desktop/protocol/editor/GlyphFileMutation.js';
import {
  GlyphMutationReceiptState,
  type GlyphMutationReceipt,
} from '#src/desktop/protocol/editor/GlyphMutationReceipt.js';
import type { EditorWorkspaceClient } from '#src/desktop/workspace/EditorWorkspaceClient.js';
import { contentRevision, EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
import type { WorkspaceMutationOptions } from '#src/workspace/WorkspaceMutationOptions.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

describe(EditorWorkspaceTextStore, () => {
  it.each(['\ud800', '\udc00', 'folder/\ud800.txt', 'folder/\udc00.txt'])(
    'rejects malformed Unicode path %j before metadata or editor requests',
    async path => {
      const client = new FixtureEditorClient('base');
      const canonical = vi.spyOn(client, 'canonicalPath');
      const request = vi.spyOn(client, 'request');
      const store = new EditorWorkspaceTextStore('/project', true, client);
      await expect(store.read(path)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      expect(() => store.canonicalPath(path)).toThrow();
      expect(() => new EditorWorkspaceTextStore(`/project/${path}`, true, client)).toThrow();
      expect(canonical).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(['delete', 'rename'] as const)(
    'recovers a %s receipt without rereading its removed source',
    async operation => {
      const client = new FixtureEditorClient('original');
      const snapshotResponse = await client.request({
        type: GlyphEditorRequestType.READ_SNAPSHOT,
        path: 'target.ts',
        operationId: 'read',
      });
      const snapshot = snapshotResponse.snapshot!;
      let sourceExists = false;
      const request = vi.spyOn(client, 'request').mockImplementation(async request => {
        if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
          return {
            operationId: request.operationId,
            ok: true,
            receipt: {
              operationId: request.operationId,
              state: GlyphMutationReceiptState.APPLIED,
              beforeRevision: snapshot.contentRevision,
              ...(operation === 'rename' ? { afterRevision: snapshot.contentRevision } : {}),
              observedAt: 'now',
            },
          };
        if (request.type === GlyphEditorRequestType.EXISTS)
          return { operationId: request.operationId, ok: true, exists: sourceExists };
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT && request.path === 'target.ts')
          return { operationId: request.operationId, ok: true, snapshot };
        throw new Error('Recovery must not repeat the mutation or read its missing source');
      });
      const store = new EditorWorkspaceTextStore('/project', true, client);
      const retry = () =>
        operation === 'rename'
          ? store.rename('source.ts', 'target.ts', snapshot.contentRevision, { operationId: 'lost-response' })
          : store.delete('source.ts', snapshot.contentRevision, { operationId: 'lost-response' });
      await retry();
      expect(request.mock.calls[0]?.[0].type).toBe(GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT);
      sourceExists = true;
      await expect(retry()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
    },
  );

  it('uses host canonical metadata for prospective path claims without loading editor snapshots', async () => {
    const canonicalPath = vi.fn(async (_path: string) => '/canonical/project/new/file');
    const request = vi.fn<EditorWorkspaceClient['request']>();
    const store = new EditorWorkspaceTextStore('/project', true, {
      canonicalPath,
      request,
      listPaths: async () => ({ files: [], truncated: false }),
    });
    await expect(store.canonicalPath('new/./file')).resolves.toBe('/canonical/project/new/file');
    expect(canonicalPath).toHaveBeenCalledWith('new/file');
    expect(() => store.canonicalPath('../escape')).toThrow();
    expect(canonicalPath).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([true, false, undefined])(
    'requires explicit editor occupancy (%s) without requesting a text snapshot',
    async exists => {
      const store = new EditorWorkspaceTextStore('/project', true, {
        canonicalPath: async path => `/project/${path}`,
        listPaths: async () => ({ files: [], truncated: false }),
        request: async request => {
          expect(request).toMatchObject({ type: GlyphEditorRequestType.EXISTS, path: 'file.ts' });
          return { operationId: 'exists', ok: true, ...(exists === undefined ? {} : { exists }) };
        },
      });
      if (exists === undefined)
        await expect(store.exists('file.ts')).rejects.toMatchObject({ reason: EditFailureReason.INCONSISTENT });
      else await expect(store.exists('file.ts')).resolves.toBe(exists);
    },
  );
  it('passes read budgets to the editor and preserves budget failures for attachment callers', async () => {
    const store = new EditorWorkspaceTextStore('/project', true, {
      canonicalPath: async path => `/project/${path}`,
      listPaths: async () => ({ files: [], truncated: false }),
      request: async request => {
        expect(request).toMatchObject({ type: GlyphEditorRequestType.READ_SNAPSHOT, path: 'file.ts', maxBytes: 32 });
        return {
          operationId: 'read',
          ok: false,
          error: {
            code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
            message: 'Read limit exceeded',
            retryable: false,
            details: { maxBytes: 32, actualBytes: 64 },
          },
        };
      },
    });
    await expect(store.read('file.ts', { maxBytes: 32 })).rejects.toMatchObject({ maxBytes: 32, actualBytes: 64 });
    await expect(store.readOptional('file.ts', { maxBytes: 32 })).rejects.toMatchObject({
      maxBytes: 32,
      actualBytes: 64,
    });
  });

  it('reads live snapshots and applies a token-guarded, deduplicated text mutation', async () => {
    const client = new FixtureEditorClient('before\n');
    const store = new EditorWorkspaceTextStore('/project', true, client);
    const before = await store.read('src/file.ts');

    expect(before.text).toBe('before\n');
    expect(store.mutationConsistency).toBe(WorkspaceMutationConsistency.ATOMIC_VERSIONED);

    const after = await store.replace('src/file.ts', before.revision, 'after\n', false, {
      operationId: 'proposal:file:item',
      undoGroupId: 'proposal:file:item',
    });
    const repeated = await store.replace('src/file.ts', before.revision, 'after\n', false, {
      operationId: 'proposal:file:item',
    });

    expect(after.text).toBe('after\n');
    expect(repeated.revision).toBe(after.revision);
    expect(client.mutationCount).toBe(1);
  });

  it('revalidates after capabilities are invalidated and refuses stale content', async () => {
    const client = new FixtureEditorClient('before');
    const store = new EditorWorkspaceTextStore('/project', true, client);
    const before = await store.read('file.ts');
    store.invalidateCapabilities();
    client.setText('manual edit');

    await expect(store.replace('file.ts', before.revision, 'agent edit', false)).rejects.toMatchObject({
      reason: EditFailureReason.STALE,
    });
    expect(client.mutationCount).toBe(0);
  });

  it('rejects unsupported renderer operations, stale file changes, traversal, missing files, and invalid hashes', async () => {
    const client = new FixtureEditorClient('text');
    const store = new EditorWorkspaceTextStore('/project', true, client);
    await expect(store.create('new.ts', '', false)).rejects.toMatchObject({ reason: EditFailureReason.INCONSISTENT });
    await expect(store.rename('file.ts', 'other.ts', 'revision')).rejects.toMatchObject({
      reason: EditFailureReason.STALE,
    });
    await expect(store.delete('file.ts', 'revision')).rejects.toMatchObject({
      reason: EditFailureReason.STALE,
    });
    expect(() => store.normalizePath('../outside')).toThrowError(/project-relative/);

    client.missing = true;
    await expect(store.readOptional('missing.ts')).resolves.toBeUndefined();
    client.missing = false;
    client.invalidHash = true;
    await expect(store.read('file.ts')).rejects.toMatchObject({ reason: EditFailureReason.INCONSISTENT });
  });

  describe(EditorWorkspaceTextStore.prototype.list, () => {
    it('lists paths through the editor client', async () => {
      const listPaths = vi.fn(async () => ({ files: ['src/a.ts'], truncated: true }));
      const store = new EditorWorkspaceTextStore('/project', true, {
        canonicalPath: async path => path,
        request: vi.fn(),
        listPaths,
      });
      await expect(store.list(10, '*.ts', 'src')).resolves.toEqual({ files: ['src/a.ts'], truncated: true });
      expect(listPaths).toHaveBeenCalledExactlyOnceWith(10, '*.ts', 'src');
    });
  });

  describe(EditorWorkspaceTextStore.prototype.normalizePath, () => {
    it.each(['', '/etc/passwd', 'a\0b', '.'])('rejects %j as a project-relative file path', path => {
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(vi.fn()));
      expect(() => store.normalizePath(path)).toThrowError(/project-relative/);
    });

    it('normalizes redundant segments', () => {
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(vi.fn()));
      expect(store.normalizePath('src/./nested/../file.ts')).toBe('src/file.ts');
    });
  });

  describe(EditorWorkspaceTextStore.prototype.exists, () => {
    it('translates editor failures into edit errors', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({
          operationId: operationIdOf(request),
          ok: false,
          error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, message: 'Document changed', retryable: true },
        })),
      );
      await expect(store.exists('file.ts')).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        message: 'Document changed',
        details: { path: 'file.ts' },
      });
    });
  });

  describe(EditorWorkspaceTextStore.prototype.read, () => {
    it('reports unsupported resources as unsupported', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({
          operationId: operationIdOf(request),
          ok: false,
          error: { code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE, message: 'Binary file', retryable: false },
        })),
      );
      await expect(store.read('image.png')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'Binary file',
      });
    });

    it('reports a generic failure when the editor gives no error details', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({ operationId: operationIdOf(request), ok: false })),
      );
      await expect(store.read('file.ts')).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'The editor workspace request failed.',
      });
    });

    it('reports a successful response without a snapshot as inconsistent', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({ operationId: operationIdOf(request), ok: true })),
      );
      await expect(store.read('file.ts')).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'The editor did not return a text snapshot.',
      });
    });

    it('accepts snapshots whose revision covers a byte-order mark', async () => {
      const snapshot = editorSnapshot('file.ts', 'text', { byteOrderMark: true });
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({ operationId: operationIdOf(request), ok: true, snapshot })),
      );
      await expect(store.read('file.ts')).resolves.toEqual({
        path: 'file.ts',
        text: 'text',
        byteOrderMark: true,
        revision: contentRevision('text', true),
        byteLength: 4,
        mode: 0o644,
        identity: 'file:///project/file.ts',
      });
    });
  });

  describe(EditorWorkspaceTextStore.prototype.create, () => {
    it('creates and saves a file under the given operation', async () => {
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => ({
        operationId: operationIdOf(request),
        ok: true,
        receipt: mutationReceipt(operationIdOf(request)),
        snapshot: editorSnapshot('new.ts', 'created', { dirty: false }),
      }));
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await expect(
        store.create('new.ts', 'created', false, 0o644, { operationId: 'op', save: true }),
      ).resolves.toMatchObject({ path: 'new.ts', text: 'created' });
      expect(request).toHaveBeenCalledExactlyOnceWith({
        type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
        mutation: {
          kind: GlyphFileMutationKind.CREATE,
          path: 'new.ts',
          text: 'created',
          byteOrderMark: false,
          operationId: 'op',
          undoGroupId: 'op',
          save: true,
        },
      });
    });

    it('generates an operation while keeping a supplied undo group', async () => {
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => ({
        operationId: operationIdOf(request),
        ok: true,
        receipt: mutationReceipt(operationIdOf(request)),
        snapshot: editorSnapshot('new.ts', 'created'),
      }));
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await store.create('new.ts', 'created', false, undefined, { undoGroupId: 'group' });
      const sent = request.mock.calls[0]?.[0];
      expect(sent).toMatchObject({ mutation: { undoGroupId: 'group', operationId: expect.any(String) } });
      expect(sent && 'mutation' in sent && 'save' in sent.mutation).toBe(false);
    });

    it('reports a file operation the editor did not confirm', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({ operationId: operationIdOf(request), ok: true })),
      );
      await expect(store.create('new.ts', '', false)).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'The editor did not confirm the file operation.',
      });
    });

    it('reports a saved file operation that left the working copy dirty', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({
          operationId: operationIdOf(request),
          ok: true,
          receipt: mutationReceipt(operationIdOf(request)),
          snapshot: editorSnapshot('new.ts', ''),
        })),
      );
      await expect(store.create('new.ts', '', false, undefined, { save: true })).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'The editor applied the file change but did not save it.',
      });
    });
  });

  describe(EditorWorkspaceTextStore.prototype.rename, () => {
    it('renames with the current source token when no earlier attempt was recorded', async () => {
      const source = editorSnapshot('source.ts', 'body');
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
        if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
          return { operationId: request.operationId, ok: true };
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
          return { operationId: request.operationId, ok: true, snapshot: source };
        return {
          operationId: operationIdOf(request),
          ok: true,
          receipt: mutationReceipt(operationIdOf(request)),
          snapshot: editorSnapshot('target.ts', 'body'),
        };
      });
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await expect(
        store.rename('source.ts', 'target.ts', source.contentRevision, { operationId: 'op' }),
      ).resolves.toMatchObject({ path: 'target.ts', text: 'body' });
      expect(request).toHaveBeenLastCalledWith({
        type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
        mutation: {
          kind: GlyphFileMutationKind.RENAME,
          path: 'source.ts',
          target: 'target.ts',
          expectedContentRevision: source.contentRevision,
          expectedToken: source.token,
          operationId: 'op',
          undoGroupId: 'op',
        },
      });
    });

    it.each<WorkspaceMutationOptions>([{}, { undoGroupId: 'group' }])(
      'generates missing identifiers for %j',
      async options => {
        const source = editorSnapshot('source.ts', 'body');
        const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
          if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
            return { operationId: request.operationId, ok: true, snapshot: source };
          return {
            operationId: operationIdOf(request),
            ok: true,
            receipt: mutationReceipt(operationIdOf(request)),
            snapshot: editorSnapshot('target.ts', 'body'),
          };
        });
        const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
        await store.rename('source.ts', 'target.ts', source.contentRevision, options);
        expect(request).toHaveBeenLastCalledWith({
          type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
          mutation: expect.objectContaining({
            undoGroupId: options.undoGroupId ?? expect.any(String),
            operationId: expect.any(String),
          }),
        });
      },
    );

    it('fails when an earlier attempt cannot be inspected', async () => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({
          operationId: operationIdOf(request),
          ok: false,
          error: { code: GlyphDesktopErrorCode.HOST_UNAVAILABLE, message: 'Editor offline', retryable: true },
        })),
      );
      await expect(store.rename('source.ts', 'target.ts', 'revision', { operationId: 'op' })).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'Editor offline',
        details: { path: 'source.ts' },
      });
    });

    it('refuses to recover a rename whose target changed afterwards', async () => {
      const target = editorSnapshot('target.ts', 'edited later');
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => {
          if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
            return {
              operationId: request.operationId,
              ok: true,
              receipt: mutationReceipt(request.operationId, {
                beforeRevision: 'source-revision',
                afterRevision: contentRevision('moved', false),
              }),
            };
          if (request.type === GlyphEditorRequestType.EXISTS)
            return { operationId: request.operationId, ok: true, exists: false };
          return { operationId: operationIdOf(request), ok: true, snapshot: target };
        }),
      );
      await expect(
        store.rename('source.ts', 'target.ts', 'source-revision', { operationId: 'op' }),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE, details: { path: 'target.ts' } });
    });

    it.each([
      { state: GlyphMutationReceiptState.UNDONE, expectedRevision: 'source-revision' },
      { state: GlyphMutationReceiptState.APPLIED, expectedRevision: 'other-revision' },
    ])('refuses to recover a $state receipt when expecting $expectedRevision', async ({ state, expectedRevision }) => {
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({
          operationId: operationIdOf(request),
          ok: true,
          receipt: mutationReceipt(operationIdOf(request), { state, beforeRevision: 'source-revision' }),
        })),
      );
      await expect(
        store.rename('source.ts', 'target.ts', expectedRevision, { operationId: 'op' }),
      ).rejects.toMatchObject({ reason: EditFailureReason.STALE, details: { path: 'source.ts' } });
    });
  });

  describe(EditorWorkspaceTextStore.prototype.delete, () => {
    it('deletes and saves with the current token when no earlier attempt was recorded', async () => {
      const current = editorSnapshot('file.ts', 'body');
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
        if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
          return { operationId: request.operationId, ok: true };
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
          return { operationId: request.operationId, ok: true, snapshot: current };
        return { operationId: operationIdOf(request), ok: true, receipt: mutationReceipt(operationIdOf(request)) };
      });
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await expect(
        store.delete('file.ts', current.contentRevision, { operationId: 'op', save: true }),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenLastCalledWith({
        type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
        mutation: {
          kind: GlyphFileMutationKind.DELETE,
          path: 'file.ts',
          expectedContentRevision: current.contentRevision,
          expectedToken: current.token,
          operationId: 'op',
          undoGroupId: 'op',
          save: true,
        },
      });
    });

    it.each<WorkspaceMutationOptions>([{}, { undoGroupId: 'group' }])(
      'generates missing identifiers for %j',
      async options => {
        const current = editorSnapshot('file.ts', 'body');
        const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
          if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
            return { operationId: request.operationId, ok: true, snapshot: current };
          return { operationId: operationIdOf(request), ok: true, receipt: mutationReceipt(operationIdOf(request)) };
        });
        const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
        await store.delete('file.ts', current.contentRevision, options);
        const sent = request.mock.calls.at(-1)?.[0];
        expect(sent).toMatchObject({
          mutation: {
            operationId: expect.any(String),
            undoGroupId: options.undoGroupId ?? expect.any(String),
          },
        });
        expect(sent && 'mutation' in sent && 'save' in sent.mutation).toBe(false);
      },
    );
  });

  describe(EditorWorkspaceTextStore.prototype.replace, () => {
    it('revalidates an unread revision before mutating', async () => {
      const before = editorSnapshot('file.ts', 'before');
      const after = editorSnapshot('file.ts', 'after');
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
          return { operationId: request.operationId, ok: true, snapshot: before };
        return {
          operationId: operationIdOf(request),
          ok: true,
          receipt: mutationReceipt(operationIdOf(request), { afterRevision: after.contentRevision }),
          snapshot: after,
        };
      });
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await expect(store.replace('file.ts', before.contentRevision, 'after', false)).resolves.toMatchObject({
        text: 'after',
      });
      expect(request).toHaveBeenLastCalledWith({
        type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
        mutation: {
          operationId: expect.any(String),
          path: 'file.ts',
          expectedContentRevision: before.contentRevision,
          expectedToken: before.token,
          text: 'after',
          byteOrderMark: false,
          undoGroupId: expect.any(String),
        },
      });
    });

    it('treats a snapshot reported under a different path as stale', async () => {
      const elsewhere = editorSnapshot('other.ts', 'before');
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => ({ operationId: operationIdOf(request), ok: true, snapshot: elsewhere })),
      );
      const error = await store.replace('file.ts', elsewhere.contentRevision, 'after', false).catch(error => error);
      expect(error).toMatchObject({
        reason: EditFailureReason.STALE,
        details: { path: 'file.ts', retry: 'Read the current working copy and submit a new proposal.' },
      });
      expect(error.details).not.toHaveProperty('currentRevision');
    });

    it('refuses to change the byte-order mark', async () => {
      const before = editorSnapshot('file.ts', 'before');
      const request = vi.fn(async (request: GlyphEditorRequest): Promise<GlyphEditorResponse> => ({
        operationId: operationIdOf(request),
        ok: true,
        snapshot: before,
      }));
      const store = new EditorWorkspaceTextStore('/project', true, editorClient(request));
      await store.read('file.ts');
      await expect(store.replace('file.ts', before.contentRevision, 'after', true)).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
        message: 'Changing a document byte-order mark is not supported.',
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('refuses a repeated operation after the working copy moved past its receipt', async () => {
      let current = editorSnapshot('file.ts', 'before');
      const before = current;
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request => {
          if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
            return { operationId: request.operationId, ok: true, snapshot: current };
          current = editorSnapshot('file.ts', 'after');
          return {
            operationId: operationIdOf(request),
            ok: true,
            receipt: mutationReceipt(operationIdOf(request), { afterRevision: current.contentRevision }),
            snapshot: current,
          };
        }),
      );
      await store.read('file.ts');
      await store.replace('file.ts', before.contentRevision, 'after', false, { operationId: 'op' });
      current = editorSnapshot('file.ts', 'manual edit');
      await expect(
        store.replace('file.ts', before.contentRevision, 'after', false, { operationId: 'op' }),
      ).rejects.toMatchObject({
        reason: EditFailureReason.INCONSISTENT,
        message: 'The mutation receipt no longer matches the working copy.',
      });
    });

    it('surfaces editor rejections of the mutation', async () => {
      const before = editorSnapshot('file.ts', 'before');
      const store = new EditorWorkspaceTextStore(
        '/project',
        true,
        editorClient(async request =>
          request.type === GlyphEditorRequestType.READ_SNAPSHOT
            ? { operationId: request.operationId, ok: true, snapshot: before }
            : {
                operationId: operationIdOf(request),
                ok: false,
                error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, message: 'Token expired', retryable: true },
              },
        ),
      );
      await expect(store.replace('file.ts', before.contentRevision, 'after', false)).rejects.toMatchObject({
        reason: EditFailureReason.STALE,
        message: 'Token expired',
      });
    });

    it.each([{ receipt: mutationReceipt('op') }, { snapshot: editorSnapshot('file.ts', 'after') }])(
      'reports an incomplete mutation result %#',
      async partial => {
        const before = editorSnapshot('file.ts', 'before');
        const store = new EditorWorkspaceTextStore(
          '/project',
          true,
          editorClient(async request =>
            request.type === GlyphEditorRequestType.READ_SNAPSHOT
              ? { operationId: request.operationId, ok: true, snapshot: before }
              : { operationId: operationIdOf(request), ok: true, ...partial },
          ),
        );
        await expect(store.replace('file.ts', before.contentRevision, 'after', false)).rejects.toMatchObject({
          reason: EditFailureReason.INCONSISTENT,
          message: 'The editor returned an incomplete mutation result.',
        });
      },
    );
  });
});

describe(contentRevision, () => {
  it('hashes the byte-order mark together with the text', () => {
    expect(contentRevision('text', true)).toBe(
      createHash('sha256')
        .update(Buffer.from([0xef, 0xbb, 0xbf]))
        .update('text', 'utf8')
        .digest('hex'),
    );
    expect(contentRevision('text', true)).not.toBe(contentRevision('text', false));
  });
});

function editorClient(request: EditorWorkspaceClient['request']): EditorWorkspaceClient {
  return {
    canonicalPath: async path => `/project/${path}`,
    listPaths: async () => ({ files: [], truncated: false }),
    request,
  };
}

function operationIdOf(request: GlyphEditorRequest): string {
  return 'mutation' in request ? request.mutation.operationId : request.operationId;
}

function editorSnapshot(
  path: string,
  text: string,
  overrides: Partial<GlyphEditorTextSnapshot> = {},
): GlyphEditorTextSnapshot {
  const byteOrderMark = overrides.byteOrderMark ?? false;
  return {
    uri: `file:///project/${path}`,
    path,
    text,
    byteOrderMark,
    contentRevision: contentRevision(text, byteOrderMark),
    byteLength: Buffer.byteLength(text),
    mode: 0o644,
    identity: `file:///project/${path}`,
    dirty: true,
    token: { workspaceGeneration: 'generation', resource: `file:///project/${path}`, incarnation: 'model', version: 1 },
    ...overrides,
  };
}

function mutationReceipt(operationId: string, overrides: Partial<GlyphMutationReceipt> = {}): GlyphMutationReceipt {
  return {
    operationId,
    state: GlyphMutationReceiptState.APPLIED,
    beforeRevision: 'before',
    observedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

class FixtureEditorClient implements EditorWorkspaceClient {
  mutationCount = 0;
  missing = false;
  invalidHash = false;
  private version = 1;

  constructor(private text: string) {}

  async canonicalPath(path: string): Promise<string> {
    return `/project/${path}`;
  }

  setText(text: string): void {
    this.text = text;
    this.version++;
  }

  listPaths(
    _maxFiles: number,
    _globPattern?: string,
    _targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }> {
    return Promise.resolve({ files: ['file.ts'], truncated: false });
  }

  async request(request: GlyphEditorRequest): Promise<GlyphEditorResponse> {
    if (request.type === GlyphEditorRequestType.READ_SNAPSHOT) {
      if (this.missing) {
        return {
          operationId: request.operationId,
          ok: false,
          error: { code: GlyphDesktopErrorCode.NOT_FOUND, message: 'missing', retryable: false },
        };
      }
      return { operationId: request.operationId, ok: true, snapshot: this.snapshot(request.path) };
    }
    if (request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION) {
      this.mutationCount++;
      const beforeRevision = contentRevision(this.text, false);
      if (
        request.mutation.expectedContentRevision !== beforeRevision ||
        request.mutation.expectedToken.version !== this.version
      ) {
        return {
          operationId: request.mutation.operationId,
          ok: false,
          error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, message: 'stale', retryable: true },
        };
      }
      this.setText(request.mutation.text);
      const snapshot = this.snapshot(request.mutation.path);
      return {
        operationId: request.mutation.operationId,
        ok: true,
        snapshot,
        receipt: {
          operationId: request.mutation.operationId,
          state: GlyphMutationReceiptState.APPLIED,
          beforeRevision,
          afterRevision: snapshot.contentRevision,
          appliedToken: snapshot.token,
          observedAt: '2026-10-08T00:00:00.000Z',
        },
      };
    }
    return {
      operationId: 'mutation' in request ? request.mutation.operationId : request.operationId,
      ok: false,
      error: { code: GlyphDesktopErrorCode.INVALID_REQUEST, message: 'unsupported', retryable: false },
    };
  }

  private snapshot(path: string): GlyphEditorTextSnapshot {
    return {
      uri: `file:///project/${path}`,
      path,
      text: this.text,
      byteOrderMark: false,
      contentRevision: this.invalidHash ? 'invalid' : contentRevision(this.text, false),
      byteLength: Buffer.byteLength(this.text),
      mode: 0o644,
      identity: `file:///project/${path}`,
      dirty: true,
      token: {
        workspaceGeneration: 'generation',
        resource: `file:///project/${path}`,
        incarnation: 'incarnation',
        version: this.version,
      },
    };
  }
}

it('requires the renderer to confirm a saved working copy for immediate agent edits', async () => {
  const client = new FixtureEditorClient('before');
  const store = new EditorWorkspaceTextStore('/project', true, client);
  const before = await store.read('file.ts');
  const request = vi.spyOn(client, 'request');
  await expect(store.replace('file.ts', before.revision, 'after', false, { save: true })).rejects.toThrow(
    'did not save',
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
      mutation: expect.objectContaining({ save: true }),
    }),
  );
  expect((await store.read('file.ts')).text).toBe('after');
});

it('finishes saving a recovered rename through its existing operation ID', async () => {
  const client = new FixtureEditorClient('original');
  const snapshot = (
    await client.request({ type: GlyphEditorRequestType.READ_SNAPSHOT, path: 'target.ts', operationId: 'read' })
  ).snapshot!;
  const receipt = {
    operationId: 'rename',
    state: GlyphMutationReceiptState.APPLIED,
    beforeRevision: snapshot.contentRevision,
    afterRevision: snapshot.contentRevision,
    observedAt: 'now',
  };
  let saved = false;
  const request = vi.spyOn(client, 'request').mockImplementation(async request => {
    if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
      return { operationId: request.operationId, ok: true, receipt };
    if (request.type === GlyphEditorRequestType.EXISTS)
      return { operationId: request.operationId, ok: true, exists: false };
    if (request.type === GlyphEditorRequestType.READ_SNAPSHOT && request.path === 'target.ts')
      return { operationId: request.operationId, ok: true, snapshot: { ...snapshot, dirty: !saved } };
    if (request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION) {
      expect(request.mutation).toMatchObject({
        operationId: 'rename',
        save: true,
        path: 'source.ts',
        target: 'target.ts',
      });
      saved = true;
      return { operationId: 'rename', ok: true, receipt, snapshot: { ...snapshot, dirty: false } };
    }
    throw new Error('Must not read the removed source');
  });
  const store = new EditorWorkspaceTextStore('/project', true, client);
  await store.rename('source.ts', 'target.ts', snapshot.contentRevision, { operationId: 'rename', save: true });
  expect(saved).toBe(true);
  expect(
    request.mock.calls.filter(([request]) => request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION),
  ).toHaveLength(1);
});
