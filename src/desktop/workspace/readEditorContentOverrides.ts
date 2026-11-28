import { randomUUID } from 'node:crypto';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { createNullPrototypeRecord } from '#src/shared/mappers/createNullPrototypeRecord.js';

const fileLimitKiB = 512;

function snapshotLimitError(path: string, cause: unknown): Error {
  return new Error(`Editor search snapshot for ${path} exceeds the ${fileLimitKiB} KiB per-file limit.`, { cause });
}

/** Transfer only catalog-approved, physically validated live text; never fall back after a failed snapshot. */
export async function readEditorContentOverrides(
  disk: Pick<FileSystemWorkspaceTextStore, 'validateAccess'>,
  index: Pick<RustWorkspacePathIndex, 'filterPaths'>,
  request: (request: GlyphEditorRequest, signal?: AbortSignal) => Promise<GlyphEditorResponse>,
  rootPrefix: string,
  signal?: AbortSignal,
  readSource?: (path: string, maxBytes: number) => Promise<string>,
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
  const overrides = createNullPrototypeRecord<string>();
  const read =
    readSource ??
    (async (path: string, maxBytes: number) => {
      await disk.validateAccess(path);
      const response = await request(
        {
          type: GlyphEditorRequestType.READ_SNAPSHOT,
          operationId: randomUUID(),
          path: rootPrefix + path,
          maxBytes,
        },
        signal,
      );
      signal?.throwIfAborted();
      if (!response.ok && response.error?.code === GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED)
        throw snapshotLimitError(rootPrefix + path, response.error);
      if (!response.ok || !response.snapshot || response.snapshot.path !== rootPrefix + path)
        throw new Error(response.error?.message ?? 'An editor search snapshot is unavailable.');
      await disk.validateAccess(path);
      return response.snapshot.text;
    });
  let bytes = 0;
  for (const path of allowed) {
    signal?.throwIfAborted();
    const text = await read(path, fileLimitKiB * 1024).catch((error: unknown) => {
      if (error instanceof WorkspaceReadLimitError) throw snapshotLimitError(rootPrefix + path, error);
      throw error;
    });
    signal?.throwIfAborted();
    bytes += Buffer.byteLength(JSON.stringify({ [path]: text }));
    if (bytes > 768 * 1024) throw new Error('Editor search snapshots exceed the aggregate byte budget.');
    overrides[path] = text;
  }
  return overrides;
}
