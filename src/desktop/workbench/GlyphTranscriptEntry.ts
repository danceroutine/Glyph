import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';
import type { GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export enum GlyphTranscriptRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  DIAGNOSTIC = 'diagnostic',
}

/** Renderable conversation entry with optional assistant-turn progress. */
export interface GlyphTranscriptEntry {
  readonly id: string;
  readonly role: GlyphTranscriptRole;
  readonly text: string;
  readonly createdAt?: string;
  readonly questionResponses?: readonly GlyphQuestionResponse[];
  readonly checkpointTurnId?: string;
  readonly usage?: GlyphUsage;
  readonly options?: GlyphTurnOptions;
  readonly attachments?: readonly GlyphAttachmentPreview[];
  readonly progress?: Pick<GlyphRunProjection, 'reasoning' | 'tools' | 'status'>;
}
