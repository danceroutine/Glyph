import { WiredGlyphMarkdown } from '#code-oss/ui/GlyphMarkdown/GlyphMarkdown.wired.tsx';
import type { GlyphPlanViewActions, GlyphPlanViewState } from '#src/desktop/workbench/GlyphPlanView.js';
import { GlyphPlan } from './GlyphPlan.presentational.tsx';
import { useGlyphPlanState } from './useGlyphPlanState.ts';
export function WiredGlyphPlan({
  state,
  actions,
}: {
  readonly state: GlyphPlanViewState;
  readonly actions: GlyphPlanViewActions;
}) {
  const model = useGlyphPlanState(state, actions);
  return (
    <GlyphPlan {...model} markdown={<WiredGlyphMarkdown text={state.plan.markdown} openLink={model.openLink} />} />
  );
}
