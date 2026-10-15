import { describe, expect, it, vi } from 'vitest';
import { readEditorContentOverrides } from '../readEditorContentOverrides.ts';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import type { GlyphEditorTextSnapshot } from '#src/desktop/protocol/editor/GlyphEditorTextSnapshot.js';

function snapshot(path: string, text: string): GlyphEditorTextSnapshot {
  return {
    path,
    text,
    uri: `file:///project/${path}`,
    byteOrderMark: false,
    contentRevision: 'revision',
    byteLength: Buffer.byteLength(text),
    mode: 0o644,
    identity: 'file',
    dirty: true,
    token: { workspaceGeneration: 'workspace', resource: path, incarnation: 'incarnation', version: 1 },
  };
}

function fixture(text = 'unsaved') {
  const validateAccess = vi.fn(async () => {});
  const filterPaths = vi.fn(async (paths: readonly string[]) => paths.filter(path => path === 'a.ts'));
  const request = vi.fn(async (command: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
    if (command.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS)
      return { operationId: command.operationId, ok: true, workingCopyPaths: ['one/a.ts', 'one/.env', 'two/a.ts'] };
    if (command.type !== GlyphEditorRequestType.READ_SNAPSHOT) throw new Error('Unexpected request');
    return { operationId: command.operationId, ok: true, snapshot: snapshot(command.path, text) };
  });
  return {
    validateAccess,
    filterPaths,
    request,
    read: (signal?: AbortSignal) =>
      readEditorContentOverrides({ validateAccess }, { filterPaths }, request, 'one/', signal),
  };
}

describe(readEditorContentOverrides, () => {
  it('checks catalog membership and physical access before reading text, and keeps roots separate', async () => {
    const test = fixture();
    await expect(test.read()).resolves.toEqual({ 'a.ts': 'unsaved' });
    expect(test.filterPaths).toHaveBeenCalledWith(['a.ts', '.env'], undefined);
    expect(test.validateAccess.mock.invocationCallOrder[0]).toBeLessThan(test.request.mock.invocationCallOrder[1]!);
    expect(test.request.mock.calls[1]![0]).toMatchObject({
      type: 'read_snapshot',
      path: 'one/a.ts',
      maxBytes: 512 * 1024,
    });
    expect(test.validateAccess).toHaveBeenCalledTimes(2);
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('propagates a physical-path failure without requesting file text', async () => {
    const test = fixture();
    test.validateAccess.mockRejectedValue(new Error('Symlink denied'));
    await expect(test.read()).rejects.toThrow('Symlink denied');
    expect(test.request).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly on unavailable snapshots, cancellation, and aggregate overflow', async () => {
    const missing = fixture();
    missing.request.mockImplementation(async () => ({ operationId: 'missing', ok: false }));
    await expect(missing.read()).rejects.toThrow('unavailable');
    const cancelled = fixture();
    await expect(cancelled.read(AbortSignal.abort(new Error('Cancelled')))).rejects.toThrow('Cancelled');
    expect(cancelled.request).toHaveBeenCalledTimes(1);
    await expect(fixture('\u0001'.repeat(150_000)).read()).rejects.toThrow('aggregate byte budget');
  });
});
