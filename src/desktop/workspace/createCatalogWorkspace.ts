import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkspaceReadFailure } from '#src/workspace/WorkspaceReadFailure.js';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceReadOptions } from '#src/workspace/WorkspaceReadOptions.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

/** Disk-authorized catalog reads consult existing dirty buffers without retaining or opening editor models. */
export function createCatalogWorkspace(
  disk: FileSystemWorkspaceTextStore,
  workspace: WorkspaceTextStore,
  request: (request: {
    readonly type: GlyphEditorRequestType.READ_OPEN_SNAPSHOT;
    readonly operationId: string;
    readonly path: string;
    readonly maxBytes?: number;
  }) => Promise<GlyphEditorResponse>,
): WorkspaceTextStore {
  const readOptional = async (input: string, options: WorkspaceReadOptions = {}, required = false) => {
    const path = disk.normalizePath(input);
    const { maxBytes, physicalByteBudget } = options;
    // Reserve enough for the descriptor-backed verification after the editor replies.
    const diskOptions =
      physicalByteBudget === undefined
        ? options
        : { ...options, maxBytes: Math.min(maxBytes ?? Infinity, Math.floor(physicalByteBudget / 2)) };
    const before = required ? await disk.read(path, diskOptions) : await disk.readOptional(path, diskOptions);
    if (!before) return undefined;
    let completedBytes = before.byteLength;
    try {
      const response = await request({
        type: GlyphEditorRequestType.READ_OPEN_SNAPSHOT,
        operationId: randomUUID(),
        path,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      if (!response.ok) throw new Error(response.error?.message ?? 'The editor catalog snapshot is unavailable.');
      // Recheck the descriptor-backed identity and bytes after crossing processes.
      // A rebind or concurrent disk edit cannot authorize a different model read.
      const after = await disk.read(path, diskOptions);
      completedBytes += after.byteLength;
      if (before.identity !== after.identity || before.revision !== after.revision)
        throw new Error('Instruction file changed during the editor read. Retry discovery.');
      const snapshot = response.snapshot;
      if (!snapshot) return { ...after, bytesRead: completedBytes };
      if (snapshot.path !== path || !snapshot.dirty)
        throw new Error('The editor returned an invalid catalog snapshot.');
      // Code OSS can preserve an alias spelling in realpath. Compare actual files before using live guidance.
      const [modelFile, sourceFile] = await Promise.all([
        stat(fileURLToPath(snapshot.uri), { bigint: true }),
        stat(join(disk.root, path), { bigint: true }),
      ]);
      if (
        modelFile.dev !== sourceFile.dev ||
        modelFile.ino !== sourceFile.ino ||
        `${sourceFile.dev}:${sourceFile.ino}` !== after.identity
      )
        throw new Error('The dirty editor model belongs to a different instruction file.');
      return {
        ...after,
        bytesRead: completedBytes,
        text: snapshot.text,
        byteOrderMark: snapshot.byteOrderMark,
        byteLength: snapshot.byteLength,
        revision: snapshot.contentRevision,
      };
    } catch (cause) {
      throw new WorkspaceReadFailure(cause, completedBytes);
    }
  };
  return {
    root: workspace.root,
    caseSensitive: workspace.caseSensitive,
    mutationConsistency: workspace.mutationConsistency,
    normalizePath: workspace.normalizePath.bind(workspace),
    canonicalPath: workspace.canonicalPath.bind(workspace),
    list: workspace.list.bind(workspace),
    exists: workspace.exists.bind(workspace),
    readOptional,
    read: async (path, options) => (await readOptional(path, options, true))!,
    create: workspace.create.bind(workspace),
    replace: workspace.replace.bind(workspace),
    rename: workspace.rename.bind(workspace),
    delete: workspace.delete.bind(workspace),
  };
}
