import { GlyphAccountPicker } from './GlyphAccountPicker.presentational.tsx';
import { useGlyphAccountPickerState, type GlyphAccountPickerStateOptions } from './useGlyphAccountPickerState.ts';

export type WiredGlyphAccountPickerProps = GlyphAccountPickerStateOptions;

export function WiredGlyphAccountPicker(props: WiredGlyphAccountPickerProps) {
  const state = useGlyphAccountPickerState(props);
  return <GlyphAccountPicker {...state} />;
}
