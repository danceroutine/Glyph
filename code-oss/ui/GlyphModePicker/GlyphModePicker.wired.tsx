import { GlyphModePicker } from './GlyphModePicker.presentational.tsx';
import { useGlyphModePickerState, type GlyphModePickerOptions } from './useGlyphModePickerState.ts';
export function WiredGlyphModePicker(props: GlyphModePickerOptions) {
  return <GlyphModePicker {...useGlyphModePickerState(props)} />;
}
