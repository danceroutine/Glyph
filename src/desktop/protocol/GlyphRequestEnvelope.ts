import type { GlyphConnectionIdentity } from './connection/GlyphConnectionIdentity.ts';
import type { GlyphDesktopProtocolVersion } from './GlyphDesktopProtocolVersion.ts';
import type { GlyphWorkbenchCommand } from './GlyphWorkbenchCommand.ts';

/** Authenticated, deduplicatable unit delivered to the host coordinator. */
export interface GlyphRequestEnvelope extends GlyphConnectionIdentity {
  readonly protocolVersion: GlyphDesktopProtocolVersion;
  readonly requestId: string;
  readonly command: GlyphWorkbenchCommand;
}
