import { useRef, useState } from 'preact/hooks';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
export function useGlyphPlanCardsState(
  chatId: string,
  plans: readonly GlyphPlan[],
  actions: GlyphWorkbenchViewActions,
  buildingPlanIds?: readonly string[],
) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState<string>();
  const [error, setError] = useState<string>();
  const perform = async (operation: () => Promise<void> | undefined) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return {
    pending,
    error,
    plans: [...new Map(plans.map(plan => [plan.id, plan])).values()],
    building: (plan: GlyphPlan) => requested === plan.id || !!buildingPlanIds?.includes(plan.id),
    view: (plan: GlyphPlan) => perform(() => actions.viewPlan?.(chatId, plan)),
    build: (plan: GlyphPlan, newChat = false) =>
      buildingPlanIds?.includes(plan.id)
        ? Promise.resolve()
        : perform(async () => {
            setRequested(plan.id);
            try {
              await actions.buildPlan?.(chatId, plan, newChat);
            } finally {
              setRequested(undefined);
            }
          }),
  };
}
