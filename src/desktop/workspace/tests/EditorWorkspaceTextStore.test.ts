import { describe, expect, it, vi } from 'vitest';
import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import type { GlyphEditorTextSnapshot } from '#src/desktop/protocol/editor/GlyphEditorTextSnapshot.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { GlyphMutationReceiptState } from '#src/desktop/protocol/editor/GlyphMutationReceipt.js';
import type { EditorWorkspaceClient } from '#src/desktop/workspace/EditorWorkspaceClient.js';
import { contentRevision, EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
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
});

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
