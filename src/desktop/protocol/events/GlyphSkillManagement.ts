/** Native Settings and host share package previews as plain data; only the host retains installable bytes. */
export interface GlyphSkillPreview {
  readonly id: string;
  readonly action: 'install' | 'update' | 'remove';
  readonly targetId: string;
  readonly destination: { readonly label: string; readonly scope: 'user' | 'project'; readonly path: string };
  readonly name: string;
  readonly source: string;
  readonly revision: string;
  readonly files: readonly {
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
    readonly status: 'added' | 'modified' | 'removed' | 'unchanged';
    readonly beforeInfo?: GlyphSkillPreviewFileInfo;
    readonly afterInfo?: GlyphSkillPreviewFileInfo;
  }[];
}
interface GlyphSkillPreviewFileInfo {
  readonly size: number;
  readonly digest: string;
  readonly mode: number;
  readonly encoding: 'utf8' | 'binary';
}
export interface GlyphSkillTarget {
  readonly scope?: 'user' | 'project';
  readonly uri?: string;
  readonly id: string;
  readonly label: string;
}
export interface GlyphSkillDraft {
  readonly name: string;
  readonly source: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly mode?: number | undefined;
    readonly encoding: 'utf8' | 'base64';
  }[];
}
export type GlyphSkillSource =
  | { readonly kind: 'local'; readonly path: string }
  | {
      readonly kind: 'repository';
      readonly url: string;
      readonly revision: string;
      readonly directory: string;
    };
