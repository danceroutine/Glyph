import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphDesktopProtocolVersion } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';
import type { GlyphHostEvent } from './GlyphHostEvent.ts';

/** Sequence metadata lets a renderer detect gaps and request replay safely. */
export interface GlyphHostEventEnvelope extends GlyphConnectionIdentity {
  readonly protocolVersion: GlyphDesktopProtocolVersion;
  readonly hostGeneration: string;
  readonly sequence: number;
  readonly event: GlyphHostEvent;
}
