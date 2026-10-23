import { useRef, useState } from 'preact/hooks';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
export function useGlyphPlanCardsState({
  chatId,
  plans,
  actions,
  buildingPlanIds,
}: {
  readonly chatId: string;
  readonly plans: readonly GlyphPlanRecord[];
  readonly actions: GlyphWorkbenchViewActions;
  readonly buildingPlanIds?: readonly string[] | undefined;
}) {
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
    building: (plan: GlyphPlanRecord) => requested === plan.id || !!buildingPlanIds?.includes(plan.id),
    view: (plan: GlyphPlanRecord) => perform(() => actions.viewPlan?.(chatId, plan)),
    stop: actions.stopPlanBuild
      ? (plan: GlyphPlanRecord) => perform(() => actions.stopPlanBuild?.(chatId, plan.id))
      : undefined,
    build: (plan: GlyphPlanRecord, newChat = false) =>
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
