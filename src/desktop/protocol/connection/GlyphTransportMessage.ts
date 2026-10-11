import type { GlyphConnectionIdentity } from './GlyphConnectionIdentity.ts';
import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

/** Transport control messages are separate from sequenced domain events. */
export enum GlyphTransportMessageType {
  CONNECTION = 'glyph_connection',
  READY = 'glyph_connection_ready',
  ERROR = 'glyph_transport_error',
  EDITOR_REQUEST = 'glyph_editor_request',
  EDITOR_RESPONSE = 'glyph_editor_response',
}

export type GlyphTransportMessage =
  | {
      readonly type: GlyphTransportMessageType.CONNECTION;
      readonly connectionId: string;
      readonly identity: GlyphConnectionIdentity;
    }
  | {
      readonly type: GlyphTransportMessageType.READY;
      readonly identity: GlyphConnectionIdentity;
      readonly hostGeneration: string;
    }
  | { readonly type: GlyphTransportMessageType.ERROR; readonly message: string }
  | { readonly type: GlyphTransportMessageType.EDITOR_REQUEST; readonly request: GlyphEditorRequest }
  | { readonly type: GlyphTransportMessageType.EDITOR_RESPONSE; readonly response: GlyphEditorResponse };
