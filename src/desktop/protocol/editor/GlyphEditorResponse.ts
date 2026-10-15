import type { GlyphDesktopError } from '#src/desktop/protocol/GlyphDesktopError.js';
import type { GlyphEditorTextSnapshot } from './GlyphEditorTextSnapshot.ts';
import type { GlyphMutationReceipt } from './GlyphMutationReceipt.ts';
import type { GlyphWorkingCopySearchResult } from './GlyphWorkingCopySearchResult.ts';

/**
 * One response shape keeps the MessagePort request router simple. Callers must
 * still validate the fields required by the corresponding request.
 */
export interface GlyphEditorResponse {
  readonly operationId: string;
  readonly ok: boolean;
  readonly exists?: boolean;
  readonly snapshot?: GlyphEditorTextSnapshot;
  readonly workingCopies?: readonly GlyphEditorTextSnapshot[];
  readonly workingCopyPaths?: readonly string[];
  readonly search?: GlyphWorkingCopySearchResult;
  readonly receipt?: GlyphMutationReceipt;
  readonly error?: GlyphDesktopError;
}
