import type { GlyphHostEventType } from './GlyphHostEvent.ts';

export interface GlyphCommandResultHostEvent {
  readonly type: GlyphHostEventType.COMMAND_RESULT;
  readonly requestId: string;
  readonly ok: true;
}
