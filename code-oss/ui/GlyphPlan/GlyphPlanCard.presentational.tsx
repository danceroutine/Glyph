import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { GlyphPlanBuild } from './GlyphPlanBuild.presentational.tsx';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
import { planStyles } from './GlyphPlan.styles.ts';
export function GlyphPlanCard({
  plan,
  view,
  build,
  buildNew,
  stop,
  disabled,
  building = false,
}: {
  readonly plan: GlyphPlanRecord;
  readonly view: () => void;
  readonly build: () => void;
  readonly buildNew: () => void;
  readonly stop?: (() => void) | undefined;
  readonly disabled: boolean;
  readonly building?: boolean;
}) {
  return (
    <article class={`glyph-plan-card ${planStyles.card}`} aria-label={`Plan: ${plan.title}`}>
      <small>Created Plan</small>
      <h3>{plan.title}</h3>
      <p>{plan.summary}</p>
      <footer>
        <Button appearance={ButtonAppearance.GHOST} onClick={view}>
          View Plan
        </Button>
        <GlyphPlanBuild build={build} buildNew={buildNew} stop={stop} disabled={disabled} building={building} />
      </footer>
    </article>
  );
}
