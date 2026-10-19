export enum GlyphAgentReviewScope {
  LAST_COMMIT = 'lastCommit',
  STAGED = 'staged',
  ALL_LOCAL = 'allLocal',
  BRANCH = 'branch',
}
export const glyphAgentReviewLabels: Readonly<Record<GlyphAgentReviewScope, string>> = {
  [GlyphAgentReviewScope.LAST_COMMIT]: 'Last commit',
  [GlyphAgentReviewScope.STAGED]: 'Staged changes',
  [GlyphAgentReviewScope.ALL_LOCAL]: 'All local changes',
  [GlyphAgentReviewScope.BRANCH]: 'Compare against branch',
};
export interface GlyphAgentReviewControls {
  readonly scope: GlyphAgentReviewScope;
  readonly branch: string;
  readonly busy: boolean;
  readonly unavailableReason?: string;
  readonly error?: string;
  readonly chooseScope: (scope: GlyphAgentReviewScope) => void;
  readonly review: () => void;
}
export type GlyphAgentReviewMount = (
  container: HTMLElement,
  controls: GlyphAgentReviewControls,
) => {
  update(controls: GlyphAgentReviewControls): void;
  dispose(): void;
};
