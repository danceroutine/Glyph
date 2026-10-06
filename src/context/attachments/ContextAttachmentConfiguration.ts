/** Configurable resource limits applied while resolving prompt attachments. */
export interface ContextAttachmentConfiguration {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}
