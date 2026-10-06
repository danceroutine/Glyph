/** Exact text and revision metadata supplied to a provider as prompt context. */
export interface ContextAttachment {
  readonly path: string;
  readonly revision: string;
  readonly text: string;
  readonly byteOrderMark: boolean;
  readonly byteLength: number;
}
