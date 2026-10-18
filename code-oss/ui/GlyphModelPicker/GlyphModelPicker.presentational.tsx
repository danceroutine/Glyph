import { ChevronDown } from 'lucide-preact';
import type { GlyphModelPickerState } from './useGlyphModelPickerState.ts';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    minWidth: 0,
    color: tokens.text.primary,
    font: 'inherit',
    padding: tokens.space.xs,
    '&:focus-within': { outline: tokens.focus.ring },
    '& > span': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& > svg': { flexShrink: 0, color: tokens.text.muted },
  }),
  select: css({
    position: 'absolute',
    inset: 0,
    width: '100%',
    minWidth: 0,
    opacity: 0,
    background: tokens.dropdown.background,
    color: tokens.dropdown.foreground,
    border: '1px solid transparent',
    cursor: 'pointer',
    ':disabled': { cursor: 'default' },
  }),
};
export type GlyphModelPickerProps = GlyphModelPickerState;
export function GlyphModelPicker({ model, label, disabled, models, selectModel }: GlyphModelPickerProps) {
  return (
    <label class={`glyph-model-picker ${styles.root}`} title={label}>
      <span>{label}</span>
      <ChevronDown size={14} aria-hidden="true" />
      <select
        class={styles.select}
        aria-label="Model"
        value={model}
        disabled={disabled}
        onChange={event => selectModel(event.currentTarget.value)}
      >
        {models.map(model => (
          <option key={model.value} value={model.value}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}
