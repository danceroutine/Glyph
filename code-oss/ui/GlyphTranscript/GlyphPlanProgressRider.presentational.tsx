import type { GlyphPlanProgress } from '#src/desktop/protocol/events/GlyphPlanProgress.js';
import { GlyphTodoStatusIcon } from '#code-oss/ui/GlyphTodoCard/GlyphTodoList.presentational.tsx';
import { transcriptStyles as styles } from './GlyphTranscript.styles.ts';

export function GlyphPlanProgressRider({ progress }: { readonly progress: GlyphPlanProgress }) {
  return (
    <div
      class={`glyph-plan-progress ${styles.riderRow}`}
      role="note"
      title={`Sent while building ${progress.title}`}
      aria-label={`Sent while building ${progress.title}: ${progress.completed} of ${progress.total} to-dos completed`}
    >
      <GlyphTodoStatusIcon
        status={progress.completed === progress.total && progress.total > 0 ? 'completed' : 'in_progress'}
      />
      <span>{progress.current ?? progress.title}</span>
      <small>
        {progress.completed}/{progress.total}
      </small>
    </div>
  );
}
