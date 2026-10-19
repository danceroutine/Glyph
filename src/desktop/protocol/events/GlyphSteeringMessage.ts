import type { GlyphTurnOptions } from './GlyphAnnotation.ts';
import type { GlyphAttachmentPreview } from './GlyphAttachmentPreview.ts';

/** A user instruction accepted into an existing run, without cancelling its tools. */
export interface GlyphSteeringMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly options: GlyphTurnOptions;
  readonly attachments: readonly GlyphAttachmentPreview[];
}
