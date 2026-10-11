import type { GlyphDesktopError } from '#src/desktop/protocol/GlyphDesktopError.js';
import type { GlyphHostEventType } from './GlyphHostEvent.ts';

export interface GlyphErrorHostEvent {
  readonly type: GlyphHostEventType.ERROR;
  readonly requestId?: string;
  readonly error: GlyphDesktopError;
}
