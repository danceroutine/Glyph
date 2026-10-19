import { useMemo } from 'preact/hooks';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { composerFixture } from './fixtures/ActionFixtures.ts';
import type { Decorator } from '@storybook/preact-vite';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';

export const agentMessageDecorators: Decorator[] = [
  Story => (
    <div class={`glyph-workbench ${workbenchClassName}`} style={{ padding: 16 }}>
      <Story />
    </div>
  ),
];

/** Args are reusable seeds. Each mounted story gets its own mutable composer controller. */
export const isolateComposer: Decorator = (Story, context) => {
  const value = context.args.actions;
  const actions = typeof value === 'object' && value !== null && 'composer' in value ? value : undefined;
  const seed = actions?.composer;
  const composer = useMemo(
    () =>
      seed instanceof GlyphComposerState
        ? composerFixture({
            document: seed.snapshot.document,
            queued: seed.snapshot.queued.map(message => message.document),
          })
        : undefined,
    [context.id, seed],
  );
  return composer ? <Story args={{ ...context.args, actions: { ...actions, composer } }} /> : <Story />;
};
