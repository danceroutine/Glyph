import type { GlyphTextRange } from '#src/desktop/protocol/connection/GlyphTextRange.js';

/** Historical captured data, not a capability to mutate or reread its source. */
export interface GlyphAttachmentPreview {
  readonly path: string;
  readonly uri?: string;
  readonly text: string;
  readonly revision: string;
  readonly range?: GlyphTextRange;
  readonly side?: 'original' | 'modified';
}
