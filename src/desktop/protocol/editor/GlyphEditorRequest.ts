import type { GlyphTextMutation } from './GlyphTextMutation.ts';
import type { GlyphFileMutation } from './GlyphFileMutation.ts';
import type { GlyphWorkingCopySearchOptions } from './GlyphWorkingCopySearchOptions.ts';

/** Operations the utility host may ask the live Code OSS editor to perform. */
export enum GlyphEditorRequestType {
  EXISTS = 'exists',
  READ_SNAPSHOT = 'read_snapshot',
  READ_OPEN_SNAPSHOT = 'read_open_snapshot',
  CHECK_USER_SKILL_WORKING_COPIES = 'check_user_skill_working_copies',
  CHECK_SKILL_WORKING_COPIES = 'check_skill_working_copies',
  LIST_WORKING_COPIES = 'list_working_copies',
  LIST_WORKING_COPY_PATHS = 'list_working_copy_paths',
  SEARCH_WORKING_COPIES = 'search_working_copies',
  APPLY_TEXT_MUTATION = 'apply_text_mutation',
  APPLY_FILE_MUTATION = 'apply_file_mutation',
  INSPECT_MUTATION_RECEIPT = 'inspect_mutation_receipt',
}

/** Closed renderer-side RPC union; requests remain structured-clone-safe DTOs. */
export type GlyphEditorRequest =
  | {
      readonly type: GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES;
      readonly operationId: string;
      readonly packageName: string;
    }
  | {
      readonly type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES;
      readonly operationId: string;
      readonly scope: 'user' | 'project';
      /** The host resolved this project-package intersection against the peer's physical workspace roots. */
      readonly peerWorkspaceIntersection?: true;
      readonly directoryUri: string;
      readonly physicalPackageUri?: string;
    }
  | { readonly type: GlyphEditorRequestType.EXISTS; readonly operationId: string; readonly path: string }
  | {
      readonly type: GlyphEditorRequestType.READ_SNAPSHOT | GlyphEditorRequestType.READ_OPEN_SNAPSHOT;
      readonly operationId: string;
      readonly path: string;
      readonly maxBytes?: number;
      readonly physicalUri?: string;
    }
  | { readonly type: GlyphEditorRequestType.LIST_WORKING_COPIES; readonly operationId: string }
  | { readonly type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS; readonly operationId: string }
  | {
      readonly type: GlyphEditorRequestType.SEARCH_WORKING_COPIES;
      readonly operationId: string;
      readonly pattern: string;
      readonly options: GlyphWorkingCopySearchOptions;
    }
  | { readonly type: GlyphEditorRequestType.APPLY_TEXT_MUTATION; readonly mutation: GlyphTextMutation }
  | { readonly type: GlyphEditorRequestType.APPLY_FILE_MUTATION; readonly mutation: GlyphFileMutation }
  | { readonly type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT; readonly operationId: string };
