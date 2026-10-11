import type { GlyphDocumentToken } from '#src/desktop/protocol/connection/GlyphDocumentToken.js';

/** Immutable snapshot paired with an ephemeral token for optimistic mutation. */
export interface GlyphEditorTextSnapshot {
  readonly uri: string;
  readonly path: string;
  readonly text: string;
  readonly byteOrderMark: boolean;
  readonly contentRevision: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly identity: string;
  readonly dirty: boolean;
  readonly token: GlyphDocumentToken;
}
