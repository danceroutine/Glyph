import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphPlanCard } from './GlyphPlanCard.presentational.tsx';
import { useGlyphPlanCardsState } from './useGlyphPlanCardsState.ts';
export function WiredGlyphPlanCards({
  chatId,
  plans,
  actions,
  disabled,
}: {
  readonly chatId: string;
  readonly plans: readonly GlyphPlan[];
  readonly actions: GlyphWorkbenchViewActions;
  readonly disabled: boolean;
}) {
  const decision = useGlyphPlanCardsState(chatId, plans, actions);
  return (
    <>
      {decision.plans.map(plan => (
        <GlyphPlanCard
          key={plan.id}
          plan={plan}
          disabled={disabled || decision.pending}
          view={() => void decision.view(plan)}
          build={() => void decision.build(plan)}
          buildNew={() => void decision.build(plan, true)}
        />
      ))}
      {decision.error && <p role="alert">{decision.error}</p>}
    </>
  );
}
