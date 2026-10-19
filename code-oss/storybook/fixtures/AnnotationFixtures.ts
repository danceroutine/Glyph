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

const editorText = `type QueuedMessage = {
  id: string;
  text: string;
};

const pendingMessages: QueuedMessage[] = [];

export function enqueue(message: QueuedMessage) {
  pendingMessages.push(message);
}

export async function sendNext() {
  const next = pendingMessages.shift();
  if (!next) return;

  await send(next);
}

async function send(message: QueuedMessage) {
  console.log(message.text);
}
`;

/** Exact source text and UTF-16 ranges shared by the editor annotation previews. */
export const editorAnnotationSource = {
  id: 'editor-preview:queue.ts',
  revision: '1',
  label: 'src/queue.ts',
  text: editorText,
  selection: {
    from: editorText.indexOf('pendingMessages.shift()'),
    to: editorText.indexOf('pendingMessages.shift()') + 'pendingMessages.shift()'.length,
  },
};

export function editorAnnotationsFixture(): readonly GlyphAnnotation[] {
  return [
    { quote: 'pendingMessages.push(message)', comment: 'Keep the original attachments with each queued message.' },
    { quote: 'await send(next)', comment: 'Restore the message to the queue if sending fails.' },
  ].map(({ quote, comment }, index) =>
    annotationFixture({
      id: `editor-comment-${index + 1}`,
      order: index + 1,
      kind: 'proposal',
      sourceId: editorAnnotationSource.id,
      revision: editorAnnotationSource.revision,
      label: editorAnnotationSource.label,
      quote,
      from: editorText.indexOf(quote),
      to: editorText.indexOf(quote) + quote.length,
      comment,
    }),
  );
}
