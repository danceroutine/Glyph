import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

/**
 * Keeps the workspace adapter independent of MessagePort details. Only the
 * mutation-owning renderer implements this port because editor models live there.
 */
export interface EditorWorkspaceClient {
  request(request: GlyphEditorRequest, signal?: AbortSignal): Promise<GlyphEditorResponse>;
  listPaths(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }>;
}
