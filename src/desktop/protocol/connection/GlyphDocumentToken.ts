/**
 * Ephemeral proof that an editor model is still the exact incarnation and
 * version Glyph inspected. Tokens deliberately never enter persisted proposals.
 */
export interface GlyphDocumentToken {
  readonly workspaceGeneration: string;
  readonly resource: string;
  readonly incarnation: string;
  readonly version: number;
}
