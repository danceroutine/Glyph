import type { GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

export type GlyphPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'attachment'; readonly attachment: GlyphContextAttachment };

export interface GlyphPromptDocument {
  readonly options?: GlyphTurnOptions;
  readonly parts: readonly GlyphPromptPart[];
  /** UTF-16 offsets; an attachment occupies one position. */
  readonly from: number;
  readonly to: number;
}

export function toGlyphPromptText(parts: readonly GlyphPromptPart[]): string {
  return parts
    .map(part =>
      part.type === 'text'
        ? part.text
        : `@${part.attachment.path}${part.attachment.range ? ` (${part.attachment.range.start.line}-${part.attachment.range.end.line})` : ''}`,
    )
    .join('');
}

export function replaceGlyphPromptRange(
  document: GlyphPromptDocument,
  parts: readonly GlyphPromptPart[],
): GlyphPromptDocument {
  const slice = (start: number, end: number): GlyphPromptPart[] => {
    let offset = 0;
    return document.parts.flatMap<GlyphPromptPart>(part => {
      const size = part.type === 'text' ? part.text.length : 1;
      const from = Math.max(0, start - offset),
        to = Math.min(size, end - offset);
      offset += size;
      return to <= from
        ? []
        : part.type === 'text'
          ? [{ type: 'text' as const, text: part.text.slice(from, to) }]
          : [part];
    });
  };
  const position =
    document.from + parts.reduce((size, part) => size + (part.type === 'text' ? part.text.length : 1), 0);
  return {
    ...document,
    parts: [...slice(0, document.from), ...parts, ...slice(document.to, Infinity)],
    from: position,
    to: position,
  };
}
