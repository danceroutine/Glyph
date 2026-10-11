/**
 * Describes a local workspace root in both renderer and host terms. The URI is
 * suitable for Code OSS while the canonical path is used for overlap checks.
 */
export interface GlyphWorkspaceRoot {
  readonly name: string;
  readonly uri: string;
  readonly canonicalPath: string;
}
