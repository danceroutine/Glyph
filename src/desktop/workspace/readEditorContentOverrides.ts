import { randomUUID } from 'node:crypto';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';

/** Transfer only catalog-approved, physically validated live text; never fall back after a failed snapshot. */
export async function readEditorContentOverrides(
  disk: Pick<FileSystemWorkspaceTextStore, 'validateAccess'>,
  index: Pick<RustWorkspacePathIndex, 'filterPaths'>,
  request: (request: GlyphEditorRequest, signal?: AbortSignal) => Promise<GlyphEditorResponse>,
  rootPrefix: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  const listed = await request(
    { type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS, operationId: randomUUID() },
    signal,
  );
  if (!listed.ok || !listed.workingCopyPaths) throw new Error(listed.error?.message ?? 'Editor paths are unavailable.');
  const paths = listed.workingCopyPaths
    .filter(path => path.startsWith(rootPrefix))
    .map(path => path.slice(rootPrefix.length));
  const allowed = await index.filterPaths(paths, signal);
  const overrides: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const path of allowed) {
    signal?.throwIfAborted();
    await disk.validateAccess(path);
    const response = await request(
      {
        type: GlyphEditorRequestType.READ_SNAPSHOT,
        operationId: randomUUID(),
        path: rootPrefix + path,
        maxBytes: 512 * 1024,
      },
      signal,
    );
    signal?.throwIfAborted();
    if (!response.ok && response.error?.code === GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED)
      throw new Error(`Editor search snapshot for ${rootPrefix + path} exceeds the 512 KiB per-file limit.`);
    if (!response.ok || !response.snapshot || response.snapshot.path !== rootPrefix + path)
      throw new Error(response.error?.message ?? 'An editor search snapshot is unavailable.');
    await disk.validateAccess(path);
    bytes += Buffer.byteLength(JSON.stringify({ [path]: response.snapshot.text }));
    if (bytes > 768 * 1024) throw new Error('Editor search snapshots exceed the aggregate byte budget.');
    overrides[path] = response.snapshot.text;
  }
  return overrides;
}
