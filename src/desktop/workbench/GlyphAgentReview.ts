import type { GlyphAgentReviewFinding } from './GlyphAgentReviewFinding.ts';
import { AgentReviewScope as GlyphAgentReviewScope } from '#src/reviewing/AgentReview.js';
export { GlyphAgentReviewScope };
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
  readonly reviewing?: boolean;
  readonly stop?: () => void;
  readonly findings?: readonly GlyphAgentReviewFinding[];
  readonly completed?: boolean;
  readonly resultScope?: string;
  readonly openFinding?: (id: string) => void;
  readonly fixAll?: () => void;
  readonly fixFinding?: (id: string) => void;
  readonly dismissFinding?: (id: string) => void;
  readonly fileIconClasses?: (path: string) => readonly string[];
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
