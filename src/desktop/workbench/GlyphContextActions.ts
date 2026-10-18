import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

export interface GlyphContextCandidate {
  readonly uri: string;
  readonly path: string;
  readonly detail?: string;
}
export interface GlyphContextActions {
  selectFiles(): Promise<readonly GlyphContextAttachment[]>;
  searchFiles(query: string): Promise<readonly GlyphContextCandidate[]>;
  captureFile(uri: string): Promise<GlyphContextAttachment>;
  openAttachment(attachment: Pick<GlyphAttachmentPreview, 'path' | 'uri' | 'range'>): Promise<void>;
  refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment>;
  checkAttachment(attachment: GlyphContextAttachment): Promise<string | undefined>;
}
