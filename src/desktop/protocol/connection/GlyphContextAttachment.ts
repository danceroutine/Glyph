import type { GlyphTextRange } from './GlyphTextRange.ts';
import type { GlyphDocumentToken } from './GlyphDocumentToken.ts';

export enum GlyphContextAttachmentKind {
  SELECTION = 'selection',
  FILE = 'file',
}

/** Captures exactly what the user authorized at send time, including its editor capability. */
export interface GlyphContextAttachment {
  readonly kind: GlyphContextAttachmentKind;
  readonly uri: string;
  readonly path: string;
  readonly text: string;
  readonly contentRevision: string;
  readonly token: GlyphDocumentToken;
  readonly range?: GlyphTextRange;
}
