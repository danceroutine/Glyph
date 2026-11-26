/** One user-selectable native installation location. Compatibility catalogs remain separately identified. */
export interface SkillInstallTarget {
  readonly uri?: string;
  readonly id: string;
  readonly label: string;
}
/** A file comparison belonging to an immutable package preview. Binary content is described without rendering bytes. */
export interface SkillPreviewFile {
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}
/** Host-owned proposal token. Applying the token uses the captured bytes, never rereads a mutable source. */
export interface SkillPreview {
  readonly id: string;
  readonly action: 'install' | 'update' | 'remove';
  readonly targetId: string;
  readonly name: string;
  readonly source: string;
  readonly revision: string;
  readonly files: readonly SkillPreviewFile[];
}
