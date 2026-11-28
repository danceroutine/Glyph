import type { GlyphTextRange } from './GlyphTextRange.ts';
import type { GlyphDocumentToken } from './GlyphDocumentToken.ts';

export enum GlyphContextAttachmentKind {
  SELECTION = 'selection',
  FILE = 'file',
  FOLDER = 'folder',
  DIAGNOSTIC = 'diagnostic',
  SYMBOL = 'symbol',
  DIFF = 'diff',
  TERMINAL = 'terminal',
  TEST = 'test',
  /** Composer-only reference to a manual instruction rule; never serialized as captured file content. */
  RULE = 'rule',
}

/** The host binds the editor URI to this workspace-relative route. */
export interface GlyphAttachmentResource {
  readonly uri: string;
  readonly path: string;
  readonly folder: boolean;
  /** Language-service results use automatic project access. */
  readonly projectFile?: boolean;
}

/** Names released by the project index when the user captures a directory. */
export interface GlyphFolderListing {
  readonly files: readonly string[];
  readonly truncated: boolean;
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
  readonly ruleId?: string;
  readonly folderListing?: GlyphFolderListing;
  readonly projectFile?: true;
  /** The capture remains visible, but cannot be sent under the current workspace authority. */
  readonly unavailable?: string;
  /** Historical snapshots have no live editor capability. */
  readonly token?: GlyphDocumentToken;
  readonly sourceVersion?: number;
  readonly range?: GlyphTextRange;
}
