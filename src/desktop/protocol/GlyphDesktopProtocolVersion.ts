/**
 * Versions the serialized contract shared by independently built Code OSS and
 * Glyph processes. A numeric enum keeps the wire value compact while making a
 * version bump an explicit source change.
 */
export enum GlyphDesktopProtocolVersion {
  V1 = 1,
  V2 = 2,
  V3 = 3,
}

/** The only protocol version emitted by this build. */
export const GLYPH_DESKTOP_PROTOCOL_VERSION = GlyphDesktopProtocolVersion.V3;

/** Rejects unknown wire values before their payload is interpreted. */
export function isGlyphProtocolVersion(value: unknown): value is GlyphDesktopProtocolVersion {
  return value === GLYPH_DESKTOP_PROTOCOL_VERSION;
}
