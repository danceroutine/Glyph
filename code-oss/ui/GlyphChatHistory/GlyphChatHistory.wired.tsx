import { GlyphChatHistory } from './GlyphChatHistory.presentational.tsx';
import { WiredGlyphAccountPicker } from '../GlyphAccountPicker/GlyphAccountPicker.wired.tsx';
import { useGlyphChatHistoryState, type GlyphChatHistoryStateOptions } from './useGlyphChatHistoryState.ts';

export type WiredGlyphChatHistoryProps = GlyphChatHistoryStateOptions;

export function WiredGlyphChatHistory(props: WiredGlyphChatHistoryProps) {
  const state = useGlyphChatHistoryState(props);
  return (
    <GlyphChatHistory
      {...state}
      accountControl={<WiredGlyphAccountPicker state={props.state} actions={props.actions} />}
    />
  );
}
