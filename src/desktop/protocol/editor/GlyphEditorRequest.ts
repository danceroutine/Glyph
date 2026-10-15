import type { GlyphTextMutation } from './GlyphTextMutation.ts';
import type { GlyphWorkingCopySearchOptions } from './GlyphWorkingCopySearchOptions.ts';

/** Operations the utility host may ask the live Code OSS editor to perform. */
export enum GlyphEditorRequestType {
  EXISTS = 'exists',
  READ_SNAPSHOT = 'read_snapshot',
  LIST_WORKING_COPIES = 'list_working_copies',
  SEARCH_WORKING_COPIES = 'search_working_copies',
  APPLY_TEXT_MUTATION = 'apply_text_mutation',
  INSPECT_MUTATION_RECEIPT = 'inspect_mutation_receipt',
}

/** Closed renderer-side RPC union; requests remain structured-clone-safe DTOs. */
export type GlyphEditorRequest =
  | { readonly type: GlyphEditorRequestType.EXISTS; readonly operationId: string; readonly path: string }
  | {
      readonly type: GlyphEditorRequestType.READ_SNAPSHOT;
      readonly operationId: string;
      readonly path: string;
      readonly maxBytes?: number;
    }
  | { readonly type: GlyphEditorRequestType.LIST_WORKING_COPIES; readonly operationId: string }
  | {
      readonly type: GlyphEditorRequestType.SEARCH_WORKING_COPIES;
      readonly operationId: string;
      readonly pattern: string;
      readonly options: GlyphWorkingCopySearchOptions;
    }
  | { readonly type: GlyphEditorRequestType.APPLY_TEXT_MUTATION; readonly mutation: GlyphTextMutation }
  | { readonly type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT; readonly operationId: string };
