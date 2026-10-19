import { GlyphChatHistory } from './GlyphChatHistory.presentational.tsx';
import { WiredGlyphAccountPicker } from '#code-oss/ui/GlyphAccountPicker/GlyphAccountPicker.wired.tsx';
import { useGlyphChatHistoryState, type GlyphChatHistoryStateOptions } from './useGlyphChatHistoryState.ts';

export type WiredGlyphChatHistoryProps = GlyphChatHistoryStateOptions &
  Pick<import('./GlyphChatHistory.presentational.tsx').GlyphChatHistoryProps, 'compact' | 'close' | 'toggleRef'>;

export function WiredGlyphChatHistory(props: WiredGlyphChatHistoryProps) {
  const state = useGlyphChatHistoryState(props);
  return (
    <GlyphChatHistory
      {...state}
      {...(props.compact ? { compact: true } : {})}
      {...(props.close ? { close: props.close } : {})}
      {...(props.toggleRef ? { toggleRef: props.toggleRef } : {})}
      accountControl={<WiredGlyphAccountPicker state={props.state} actions={props.actions} />}
    />
  );
}
