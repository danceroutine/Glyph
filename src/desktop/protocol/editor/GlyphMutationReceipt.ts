import type { GlyphDocumentToken } from '#src/desktop/protocol/connection/GlyphDocumentToken.js';

export enum GlyphMutationReceiptState {
  APPLIED = 'applied',
  SAVED = 'saved',
  UNDONE = 'undone',
  UNKNOWN = 'unknown',
}

/** Idempotency evidence retained by both sides after a mutation attempt. */
export interface GlyphMutationReceipt {
  readonly operationId: string;
  readonly state: GlyphMutationReceiptState;
  readonly beforeRevision: string;
  readonly afterRevision?: string;
  readonly appliedToken?: GlyphDocumentToken;
  readonly observedAt: string;
}
