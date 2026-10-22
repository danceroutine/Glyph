import { WiredGlyphModePicker } from '#code-oss/ui/GlyphModePicker/GlyphModePicker.wired.tsx';
import type { ComponentChildren } from 'preact';
import { GlyphComposer } from './GlyphComposer.presentational.tsx';
import { useGlyphComposerState, type GlyphComposerStateOptions } from './useGlyphComposerState.ts';

export interface WiredGlyphComposerProps extends GlyphComposerStateOptions {
  readonly modelControl?: ComponentChildren;
  readonly todos?: ComponentChildren;
  readonly terminals?: ComponentChildren;
  readonly reviews?: ComponentChildren;
}

export function WiredGlyphComposer({ modelControl, todos, reviews, terminals, ...props }: WiredGlyphComposerProps) {
  const state = useGlyphComposerState(props);
  return (
    <GlyphComposer
      {...state}
      modelControl={modelControl}
      todos={todos}
      reviews={reviews}
      terminals={terminals}
      modeControl={
        <WiredGlyphModePicker
          mode={state.mode}
          change={mode => {
            void state.setMode(mode);
          }}
        />
      }
    />
  );
}
