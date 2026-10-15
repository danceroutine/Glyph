import { describe, expect, it, vi } from 'vitest';
import { readEditorContentOverrides } from '#src/desktop/workspace/readEditorContentOverrides.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import type { GlyphEditorTextSnapshot } from '#src/desktop/protocol/editor/GlyphEditorTextSnapshot.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';

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

  it('retains an empty editor snapshot so disk matches cannot reappear', async () => {
    await expect(fixture('').read()).resolves.toEqual({ 'a.ts': '' });
  });

  it('identifies the file and limit when a live buffer exceeds its byte budget', async () => {
    const test = fixture();
    test.request.mockImplementation(async command => {
      if (command.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS)
        return { operationId: command.operationId, ok: true, workingCopyPaths: ['one/a.ts'] };
      if (command.type !== GlyphEditorRequestType.READ_SNAPSHOT) throw new Error('Unexpected request');
      return {
        operationId: command.operationId,
        ok: false,
        error: { code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED, message: 'READ_LIMIT_EXCEEDED', retryable: false },
      };
    });
    await expect(test.read()).rejects.toThrow(
      'Editor search snapshot for one/a.ts exceeds the 512 KiB per-file limit.',
    );
  });

  it.each(['failed', 'missing', 'wrong path'] as const)(
    'refuses a %s snapshot after successful discovery',
    async failure => {
      const test = fixture();
      test.request.mockImplementation(async command => {
        if (command.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS)
          return { operationId: command.operationId, ok: true, workingCopyPaths: ['one/a.ts'] };
        if (command.type !== GlyphEditorRequestType.READ_SNAPSHOT) throw new Error('Unexpected request');
        return {
          operationId: command.operationId,
          ok: failure !== 'failed',
          ...(failure === 'wrong path' ? { snapshot: snapshot('two/a.ts', 'wrong root') } : {}),
        };
      });
      await expect(test.read()).rejects.toThrow('snapshot is unavailable');
    },
  );

  it('refuses text when physical access changes while the snapshot is being read', async () => {
    const test = fixture();
    test.validateAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Path replaced'));
    await expect(test.read()).rejects.toThrow('Path replaced');
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('discards a snapshot returned after cancellation', async () => {
    const test = fixture();
    const controller = new AbortController();
    test.request.mockImplementation(async command => {
      if (command.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS)
        return { operationId: command.operationId, ok: true, workingCopyPaths: ['one/a.ts'] };
      if (command.type !== GlyphEditorRequestType.READ_SNAPSHOT) throw new Error('Unexpected request');
      controller.abort(new Error('Search stopped'));
      return { operationId: command.operationId, ok: true, snapshot: snapshot('one/a.ts', 'late text') };
    });
    await expect(test.read(controller.signal)).rejects.toThrow('Search stopped');
    expect(test.validateAccess).toHaveBeenCalledTimes(1);
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
