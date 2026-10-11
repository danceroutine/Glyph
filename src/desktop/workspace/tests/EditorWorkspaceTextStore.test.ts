import { describe, expect, it } from 'vitest';
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

  it('fails closed for structural edits, traversal, missing files, and invalid snapshot hashes', async () => {
    const client = new FixtureEditorClient('text');
    const store = new EditorWorkspaceTextStore('/project', true, client);
    await expect(store.create('new.ts', '', false)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    await expect(store.rename('file.ts', 'other.ts', 'revision')).rejects.toMatchObject({
      reason: EditFailureReason.UNSUPPORTED,
    });
    await expect(store.delete('file.ts', 'revision')).rejects.toMatchObject({
      reason: EditFailureReason.UNSUPPORTED,
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
      operationId: request.operationId,
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
