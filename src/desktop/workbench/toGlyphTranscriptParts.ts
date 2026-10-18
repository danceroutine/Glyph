import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphTranscriptEntry } from './GlyphTranscriptEntry.ts';

export type GlyphTranscriptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'attachment'; readonly attachment: GlyphAttachmentPreview };

/** New messages retain exact badge positions; older messages use their serialized mentions. */
export function toGlyphTranscriptParts(entry: GlyphTranscriptEntry): readonly GlyphTranscriptPart[] {
  const parts: GlyphTranscriptPart[] = [];
  const remaining: GlyphAttachmentPreview[] = [];
  let offset = 0;
  for (const [index, attachment] of (entry.attachments ?? []).entries()) {
    const mention = `@${attachment.path}${attachment.range ? ` (${attachment.range.start.line}-${attachment.range.end.line})` : ''}`;
    const span = entry.options?.attachmentSpans?.[index];
    const from = span?.from ?? entry.text.indexOf(mention, offset);
    const to = span?.to ?? from + mention.length;
    if (from < offset || to > entry.text.length || entry.text.slice(from, to) !== mention) {
      remaining.push(attachment);
      continue;
    }
    if (from > offset) parts.push({ type: 'text', text: entry.text.slice(offset, from) });
    parts.push({ type: 'attachment', attachment });
    offset = to;
  }
  if (offset < entry.text.length) parts.push({ type: 'text', text: entry.text.slice(offset) });
  for (const attachment of remaining) parts.push({ type: 'text', text: ' ' }, { type: 'attachment', attachment });
  return parts;
}
