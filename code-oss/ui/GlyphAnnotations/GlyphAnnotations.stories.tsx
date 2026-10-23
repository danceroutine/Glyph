import type { ComponentProps } from 'preact';
import { fn } from 'storybook/test';
import { annotationFixture } from '#code-oss/storybook/fixtures/AnnotationFixtures.ts';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { useState } from 'preact/hooks';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphAnnotationPill } from './GlyphAnnotations.presentational.tsx';
const meta = {
  title: 'Glyph/Shared/Annotations/Annotations Pill',
  component: GlyphAnnotationPill,
  args: {
    annotations: [annotationFixture()],
    edit: fn().mockName('GlyphAnnotations.edit'),
    remove: fn().mockName('GlyphAnnotations.remove'),
  },
  decorators: [
    Story => (
      <div style={{ padding: '24px', paddingTop: '300px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GlyphAnnotationPill>;
export default meta;
type Story = StoryObj<typeof meta>;
function DraftPill({ annotations: initial }: { readonly annotations: readonly GlyphAnnotation[] }) {
  const [annotations, setAnnotations] = useState<readonly GlyphAnnotation[]>(initial);
  return (
    <GlyphAnnotationPill
      annotations={annotations}
      edit={fn().mockName('GlyphAnnotations.edit')}
      remove={fn<NonNullable<ComponentProps<typeof GlyphAnnotationPill>['remove']>>(id => {
        setAnnotations(values => values.filter(value => value.id !== id));
      }).mockName('GlyphAnnotations.remove')}
    />
  );
}
export const Draft: Story = {
  render: args => <DraftPill annotations={args.annotations} />,
};
export const Multiple: Story = {
  render: () => (
    <DraftPill
      annotations={[
        ...meta.args.annotations,
        {
          ...meta.args.annotations[0]!,
          id: '2',
          order: 2,
          quote: 'Keep the original order',
          comment: 'Include messages with file attachments.',
        },
      ]}
    />
  ),
};
export const Sent: Story = { render: () => <GlyphAnnotationPill annotations={meta.args.annotations} /> };
