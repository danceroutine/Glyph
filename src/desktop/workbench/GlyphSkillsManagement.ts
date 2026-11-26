import type {
  GlyphSkillDraft,
  GlyphSkillPreview,
  GlyphSkillSource,
  GlyphSkillTarget,
} from '#src/desktop/protocol/events/GlyphSkillManagement.js';
/** Settings actions use host proposal tokens so review and application cannot select different package versions. */
export interface GlyphSkillsManagement {
  readonly targets: readonly GlyphSkillTarget[];
  readonly message?: string;
  readonly preview?: GlyphSkillPreview;
  previewDraft(targetId: string, draft: GlyphSkillDraft): Promise<void>;
  installLocal(targetId: string, replaceId?: string): Promise<void>;
  previewRepository(
    targetId: string,
    source: Extract<GlyphSkillSource, { kind: 'repository' }>,
    replaceId?: string,
  ): Promise<void>;
  setEnabled(skillId: string, enabled: boolean): Promise<void>;
  remove(skillId: string): Promise<void>;
  apply(previewId: string): Promise<void>;
  discard(previewId: string): Promise<void>;
}
