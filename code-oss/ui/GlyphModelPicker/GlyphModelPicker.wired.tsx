import { GlyphModelPicker } from './GlyphModelPicker.presentational.tsx';
import { useGlyphModelPickerState, type GlyphModelPickerStateOptions } from './useGlyphModelPickerState.ts';

export type WiredGlyphModelPickerProps = GlyphModelPickerStateOptions;

export function WiredGlyphModelPicker(props: WiredGlyphModelPickerProps) {
  const state = useGlyphModelPickerState(props);
  return <GlyphModelPicker {...state} />;
}
