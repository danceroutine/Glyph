/** Provenance of an explicit capture; contents stay immutable after editor changes. */
export interface ContextAttachmentSource {
  readonly kind: 'selection' | 'file';
  readonly uri: string;
  readonly version: number;
  readonly revision: string;
  readonly range?: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly side?: 'original' | 'modified';
}
