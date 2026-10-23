import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { annotationFixture } from '#code-oss/storybook/fixtures/AnnotationFixtures.ts';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { WiredGlyphAnnotationCitation } from './GlyphAnnotationCitation.wired.tsx';

const passage = 'Send the next queued message only after the active run finishes.';

function CitationPreview({ annotation }: { readonly annotation: GlyphAnnotation }) {
  return (
    <div style={{ padding: '24px', paddingTop: '200px', lineHeight: 1.6 }}>
      <p data-glyph-source={annotation.sourceId} data-kind="chat" data-revision={annotation.revision}>
        {passage}
      </p>
      <p>
        I kept the ordering you asked for in{' '}
        <WiredGlyphAnnotationCitation annotation={annotation}>
          Annotation {annotation.order}
        </WiredGlyphAnnotationCitation>
        .
      </p>
    </div>
  );
}

const meta = {
  title: 'Glyph/Shared/Annotations/Annotation Citation',
  component: CitationPreview,
  args: {
    annotation: annotationFixture({
      kind: 'chat',
      sourceId: 'citation-story-source',
      revision: String(passage.length),
      quote: 'Send the next queued message',
      from: 0,
      to: 'Send the next queued message'.length,
    }),
  },
} satisfies Meta<typeof CitationPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Previewed: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.hover(within(canvasElement).getByRole('link', { name: 'Annotation 1' }));
    const preview = await within(document.body).findByRole('tooltip');
    await expect(preview).toHaveTextContent(args.annotation.quote);
    await expect(preview).toHaveTextContent(args.annotation.comment);
  },
};
export const Revealed: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('link', { name: 'Annotation 1' }));
    await waitFor(() => expect(document.querySelector('.glyph-annotation-reveal')).not.toBeNull());
  },
};
