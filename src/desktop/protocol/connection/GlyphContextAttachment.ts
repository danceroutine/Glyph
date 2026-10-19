import type { GlyphTextRange } from './GlyphTextRange.ts';
import type { GlyphDocumentToken } from './GlyphDocumentToken.ts';

export enum GlyphContextAttachmentKind {
  SELECTION = 'selection',
  FILE = 'file',
}

/** Immutable text captured when the user attaches context. The token identifies the source model, not permission to edit it. */
export interface GlyphContextAttachment {
  readonly id?: string;
  readonly sourceRevision?: string;
  readonly side?: 'original' | 'modified';
  readonly kind: GlyphContextAttachmentKind;
  readonly uri: string;
  readonly path: string;
  readonly text: string;
  readonly contentRevision: string;
  /** Historical snapshots have no live editor capability. */
  readonly token?: GlyphDocumentToken;
  readonly sourceVersion?: number;
  readonly range?: GlyphTextRange;
}
