/** Native Settings and host share package previews as plain data; only the host retains installable bytes. */
export interface GlyphSkillPreview {
  readonly id: string;
  readonly action: 'install' | 'update' | 'remove';
  readonly targetId: string;
  readonly name: string;
  readonly source: string;
  readonly revision: string;
  readonly files: readonly { readonly path: string; readonly before?: string; readonly after?: string }[];
}
export interface GlyphSkillTarget {
  readonly uri?: string;
  readonly id: string;
  readonly label: string;
}
export interface GlyphSkillDraft {
  readonly name: string;
  readonly source: string;
  readonly files: readonly { readonly path: string; readonly content: string; readonly encoding: 'utf8' | 'base64' }[];
}
export type GlyphSkillSource =
  | { readonly kind: 'local'; readonly path: string }
  | {
      readonly kind: 'repository';
      readonly url: string;
      readonly revision: string;
      readonly directory: string;
    };
