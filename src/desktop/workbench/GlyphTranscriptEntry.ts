export enum GlyphTranscriptRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  DIAGNOSTIC = 'diagnostic',
}

/** Renderable conversation projection kept deliberately independent of host DTOs. */
export interface GlyphTranscriptEntry {
  readonly id: string;
  readonly role: GlyphTranscriptRole;
  readonly text: string;
}
