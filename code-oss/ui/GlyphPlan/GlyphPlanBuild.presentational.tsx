import { ChevronDown } from 'lucide-preact';
import { planStyles } from './GlyphPlan.styles.ts';
export function GlyphPlanBuild({
  build,
  buildNew,
  disabled,
}: {
  readonly build: () => void;
  readonly buildNew: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div class={planStyles.buildGroup}>
      <button type="button" class={`${planStyles.button} ${planStyles.build}`} disabled={disabled} onClick={build}>
        Build <kbd>⌘↵</kbd>
      </button>
      <details class={planStyles.buildOptions}>
        <summary class={`${planStyles.button} ${planStyles.build}`} aria-label="Build options">
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div class={planStyles.buildMenu}>
          <button type="button" class={planStyles.button} disabled={disabled} onClick={buildNew}>
            Build in new chat
          </button>
        </div>
      </details>
    </div>
  );
}
