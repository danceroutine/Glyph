import type { GlyphDocumentToken } from '#src/desktop/protocol/connection/GlyphDocumentToken.js';

export enum GlyphFileMutationKind {
  CREATE = 'create',
  DELETE = 'delete',
  RENAME = 'rename',
}

export type GlyphFileMutation = {
  readonly operationId: string;
  readonly undoGroupId: string;
  readonly save?: boolean;
  readonly path: string;
} & (
  | { readonly kind: GlyphFileMutationKind.CREATE; readonly text: string; readonly byteOrderMark: boolean }
  | {
      readonly kind: GlyphFileMutationKind.DELETE | GlyphFileMutationKind.RENAME;
      readonly expectedContentRevision: string;
      readonly expectedToken: GlyphDocumentToken;
      readonly target?: string;
    }
);
