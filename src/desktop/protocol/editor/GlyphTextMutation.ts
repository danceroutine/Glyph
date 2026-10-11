import type { GlyphDocumentToken } from '#src/desktop/protocol/connection/GlyphDocumentToken.js';

/** Whole-document edit guarded by both a durable hash and an editor capability. */
export interface GlyphTextMutation {
  readonly operationId: string;
  readonly path: string;
  readonly expectedContentRevision: string;
  readonly expectedToken: GlyphDocumentToken;
  readonly text: string;
  readonly byteOrderMark: boolean;
  readonly undoGroupId: string;
}
