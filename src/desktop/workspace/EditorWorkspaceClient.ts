import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

/**
 * Keeps the workspace adapter independent of MessagePort details. Only the
 * mutation-owning renderer implements this port because editor models live there.
 */
export interface EditorWorkspaceClient {
  /** Resolves physical path aliases through the host's metadata-only workspace policy. */
  canonicalPath(
    path: string,
    mutation?: boolean,
    onManagedPathAdmitted?: (physicalPath: string) => void,
  ): Promise<string>;
  request(
    request: GlyphEditorRequest,
    signal?: AbortSignal,
    retainAccess?: (check: () => void) => void,
  ): Promise<GlyphEditorResponse>;
  listPaths(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }>;
}
