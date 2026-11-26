import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphTranscriptEntry } from './GlyphTranscriptEntry.ts';

export type GlyphTranscriptPart<T = GlyphAttachmentPreview> =
  { readonly type: 'text'; readonly text: string } | { readonly type: 'attachment'; readonly attachment: T };

export interface GlyphInlineMention<T> {
  readonly attachment: T;
  readonly mention: string;
  readonly span: { readonly from: number; readonly to: number } | undefined;
}

/** Position independently stored file and slash badges in one UTF-16 text projection. */
export function placeGlyphMentions<T>(
  text: string,
  mentions: readonly GlyphInlineMention<T>[],
): GlyphTranscriptPart<T>[] {
  let legacyOffset = 0;
  const located = mentions
    .map(({ attachment, mention, span }) => {
      const from = span?.from ?? text.indexOf(mention, legacyOffset);
      const to = span?.to ?? from + mention.length;
      const matches = from >= 0 && to <= text.length && text.slice(from, to) === mention;
      if (matches) legacyOffset = to;
      return { attachment, from: matches ? from : Infinity, to };
    })
    .toSorted((left, right) => left.from - right.from);
  let offset = 0;
  const parts: GlyphTranscriptPart<T>[] = [];
  const remaining: T[] = [];
  for (const { attachment, from, to } of located) {
    if (!Number.isFinite(from) || from < offset) {
      remaining.push(attachment);
      continue;
    }
    if (from > offset) parts.push({ type: 'text', text: text.slice(offset, from) });
    parts.push({ type: 'attachment', attachment });
    offset = to;
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
  for (const attachment of remaining) parts.push({ type: 'text', text: ' ' }, { type: 'attachment', attachment });
  return parts;
}

/** New messages retain exact badge positions; older messages use their serialized mentions. */
export function toGlyphTranscriptParts(entry: GlyphTranscriptEntry): readonly GlyphTranscriptPart[] {
  return placeGlyphMentions(
    entry.text,
    (entry.attachments ?? []).map((attachment, index) => ({
      attachment,
      mention: `@${attachment.path}${attachment.range ? ` (${attachment.range.start.line}-${attachment.range.end.line})` : ''}`,
      span: entry.options?.attachmentSpans?.[index],
    })),
  );
}
