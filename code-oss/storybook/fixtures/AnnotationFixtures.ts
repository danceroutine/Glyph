import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
export function annotationFixture(overrides: Partial<GlyphAnnotation> = {}): GlyphAnnotation {
  return {
    id: '1',
    order: 1,
    kind: 'plan',
    sourceId: 'plan',
    revision: '2',
    label: 'Queue composer messages',
    quote: 'Send the next queued message',
    from: 0,
    to: 28,
    comment: 'Preserve the original attachments and their exact revisions.',
    ...structuredClone(overrides),
  };
}
