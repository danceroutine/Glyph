/** Stable machine-readable failures that may cross the renderer/host boundary. */
export enum GlyphDesktopErrorCode {
  PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH',
  UNAUTHORIZED = 'UNAUTHORIZED',
  WORKSPACE_BUSY = 'WORKSPACE_BUSY',
  CHAT_BUSY = 'CHAT_BUSY',
  UNTRUSTED_WORKSPACE = 'UNTRUSTED_WORKSPACE',
  STALE_DOCUMENT = 'STALE_DOCUMENT',
  NOT_FOUND = 'NOT_FOUND',
  READ_LIMIT_EXCEEDED = 'READ_LIMIT_EXCEEDED',
  UNSUPPORTED_RESOURCE = 'UNSUPPORTED_RESOURCE',
  INVALID_REQUEST = 'INVALID_REQUEST',
  HOST_UNAVAILABLE = 'HOST_UNAVAILABLE',
  INTERNAL = 'INTERNAL',
}

/**
 * Serializable error data rather than an Error subclass because structured
 * clone and JSON do not preserve Error prototypes across process boundaries.
 */
export interface GlyphDesktopError {
  readonly code: GlyphDesktopErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}
