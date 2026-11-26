import type { GlyphTurnOptions } from './GlyphAnnotation.ts';
import type { GlyphAttachmentPreview } from './GlyphAttachmentPreview.ts';

/** A user instruction accepted into an existing run, without cancelling its tools. */
export interface GlyphSteeringMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly options: GlyphTurnOptions;
  readonly attachments: readonly GlyphAttachmentPreview[];
  /** Failed context admission; the instruction was retained for correction and was not sent to the model. */
  readonly rejection?: string;
}
