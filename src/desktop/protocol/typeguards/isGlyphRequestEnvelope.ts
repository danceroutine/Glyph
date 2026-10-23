import { isRecord } from '#src/shared/validators/isRecord.js';
import type { GlyphRequestEnvelope } from '#src/desktop/protocol/GlyphRequestEnvelope.js';

export function isGlyphRequestEnvelope(value: unknown): value is GlyphRequestEnvelope {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.windowId === 'string' &&
    typeof value.workspaceId === 'string' &&
    isRecord(value.command) &&
    typeof value.command.type === 'string'
  );
}
