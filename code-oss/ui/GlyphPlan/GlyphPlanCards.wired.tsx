import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphPlanCard } from './GlyphPlanCard.presentational.tsx';
import { useGlyphPlanCardsState } from './useGlyphPlanCardsState.ts';
export function WiredGlyphPlanCards({
  chatId,
  plans,
  actions,
  disabled,
  buildingPlanIds,
}: {
  readonly chatId: string;
  readonly plans: readonly GlyphPlan[];
  readonly actions: GlyphWorkbenchViewActions;
  readonly disabled: boolean;
  readonly buildingPlanIds?: readonly string[];
}) {
  const decision = useGlyphPlanCardsState(chatId, plans, actions, buildingPlanIds);
  return (
    <>
      {decision.plans.map(plan => (
        <GlyphPlanCard
          key={plan.id}
          plan={plan}
          disabled={disabled || decision.pending}
          building={decision.building(plan)}
          view={() => void decision.view(plan)}
          build={() => void decision.build(plan)}
          buildNew={() => void decision.build(plan, true)}
        />
      ))}
      {decision.error && <p role="alert">{decision.error}</p>}
    </>
  );
}
