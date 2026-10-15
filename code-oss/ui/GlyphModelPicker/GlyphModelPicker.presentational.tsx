import type { GlyphModelPickerState } from './useGlyphModelPickerState.ts';
import { css, tokens, space } from '../design-system/index.ts';

const style = css({
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space.md,
  marginTop: tokens.space.md,
  color: tokens.text.muted,
  fontSize: tokens.font.size.detail,
  '& select': {
    minWidth: 0,
    maxWidth: '100%',
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    padding: space('xs', 'sm'),
    font: 'inherit',
    color: tokens.dropdown.foreground,
    background: tokens.dropdown.background,
  },
  '& select:focus-visible': { outline: tokens.focus.ring },
});

export type GlyphModelPickerProps = GlyphModelPickerState;

export function GlyphModelPicker({ model, disabled, models, selectModel }: GlyphModelPickerProps) {
  return (
    <label class={`glyph-model-picker ${style}`}>
      Model
      <select
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
