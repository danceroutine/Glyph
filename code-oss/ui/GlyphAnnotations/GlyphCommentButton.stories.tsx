import { fn } from 'storybook/test';
import { composerFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { annotationFixture } from '#code-oss/storybook/fixtures/AnnotationFixtures.ts';
import { useState } from 'preact/hooks';
import type { Meta, StoryObj } from '@storybook/preact-vite';

import { GlyphCommentButton } from './GlyphCommentButton.presentational.tsx';
import { GlyphAnnotationPill, GlyphAnnotations } from './GlyphAnnotations.presentational.tsx';
import { useGlyphAnnotationsState } from './useGlyphAnnotationsState.ts';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const surface = css({ padding: tokens.space.xl, lineHeight: 1.6, background: tokens.surface.canvas, minHeight: 400 });
const prompt = css({
  marginTop: 160,
  padding: tokens.space.lg,
  background: tokens.input.background,
  borderRadius: tokens.card.radius,
});
function AnnotationExample({ kind, empty = false }: { readonly kind: 'chat' | 'plan'; readonly empty?: boolean }) {
  const quote = 'Preserve the original attachments and their exact revisions.';
  const [composer] = useState(() => {
    const composer = composerFixture();
    if (!empty)
      composer.saveAnnotation(
        annotationFixture({
          id: 'example',
          order: 1,
          kind,
          sourceId: `example-${kind}`,
          revision: '1',
          label: kind === 'plan' ? 'Queue composer messages' : 'Assistant reply',
          quote,
          from: 0,
          to: quote.length,
          comment: 'Include selections from unsaved files too.',
        }),
      );
    return composer;
  });
  const state = useGlyphAnnotationsState(composer, false);
  return (
    <div className={surface}>
      {kind === 'plan' ? <h2>Queue composer messages</h2> : <p>Worked for 3s</p>}
      <p
        data-glyph-source={`example-${kind}`}
        data-kind={kind}
        data-label={kind === 'plan' ? 'Queue composer messages' : 'Assistant reply'}
        data-revision="1"
      >
        {quote}
      </p>
      <div className={prompt}>
        <GlyphAnnotationPill annotations={state.annotations} edit={state.edit} remove={state.remove} />
        <div>Ask for follow-up changes</div>
      </div>
      <GlyphAnnotations {...state} />
    </div>
  );
}
const meta = {
  title: 'Glyph/Shared/Annotations/Inline Annotation Marker',
  component: GlyphCommentButton,
  args: { order: 1, open: fn().mockName('GlyphCommentButton.open') },
  decorators: [
    Story => (
      <div style={{ padding: '24px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GlyphCommentButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Numbered: Story = {};
export const DoubleDigit: Story = { args: { order: 12 } };
export const Selection: Story = { render: () => <AnnotationExample kind="chat" empty /> };
export const InChat: Story = { render: () => <AnnotationExample kind="chat" /> };
export const InPlan: Story = { render: () => <AnnotationExample kind="plan" /> };
