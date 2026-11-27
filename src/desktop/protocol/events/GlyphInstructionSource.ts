export interface GlyphInstructionSource {
  readonly id: string;
  readonly legacyIds?: readonly string[];
  readonly kind: string;
  readonly label: string;
  readonly path: string;
  readonly scope: string;
  readonly status: 'active' | 'error';
  readonly name?: string;
  readonly description?: string;
  readonly activation?: 'always' | 'file_pattern' | 'model' | 'manual';
  readonly globs?: readonly string[];
  readonly enabled?: boolean;
  readonly references?: readonly string[];
  readonly revision?: string;
  readonly content?: string;
  readonly uri?: string;
  readonly caseSensitive?: boolean;
  /** Store-relative mutation path. Present only for user-owned rules. */
  readonly managementPath?: string;
  /** Revision guard for mutating the user-owned rule file itself. */
  readonly managementRevision?: string;
  readonly message?: string;
}
