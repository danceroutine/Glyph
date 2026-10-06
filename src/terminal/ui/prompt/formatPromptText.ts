export type PromptTextSegment =
  { type: 'text'; value: string } | { type: 'attachment'; value: string; collapsed: boolean };

export interface PromptTextPresentation {
  segments: readonly PromptTextSegment[];
  cursorPrefix: string | undefined;
  cursorTouchesAttachment: boolean;
}

export interface PromptTextPresentationWithCursor extends PromptTextPresentation {
  cursorPrefix: string;
}

interface AttachmentMention {
  start: number;
  end: number;
  value: string;
  collapsedValue: string;
}

export function formatPromptText(
  text: string,
  attachmentPaths: readonly string[],
  cursor: number,
): PromptTextPresentationWithCursor;
export function formatPromptText(
  text: string,
  attachmentPaths: readonly string[],
  cursor?: undefined,
): PromptTextPresentation;
export function formatPromptText(
  text: string,
  attachmentPaths: readonly string[],
  cursor?: number,
): PromptTextPresentation {
  const mentions = findAttachmentMentions(text, attachmentPaths);
  const safeCursor = cursor === undefined ? undefined : Math.max(0, Math.min(cursor, text.length));
  const segments: PromptTextSegment[] = [];
  let sourceOffset = 0;
  let visibleText = '';
  let cursorPrefix: string | undefined;
  let cursorTouchesAttachment = false;

  for (const mention of mentions) {
    const plainText = text.slice(sourceOffset, mention.start);
    if (safeCursor !== undefined && cursorPrefix === undefined && safeCursor <= mention.start) {
      cursorPrefix = visibleText + text.slice(sourceOffset, safeCursor);
    }
    appendTextSegment(segments, plainText);
    visibleText += plainText;

    const expanded = safeCursor !== undefined && safeCursor >= mention.start && safeCursor <= mention.end;
    if (expanded) {
      cursorTouchesAttachment = true;
      cursorPrefix = visibleText + mention.value.slice(0, safeCursor - mention.start);
    }
    const displayedMention = expanded ? mention.value : mention.collapsedValue;
    segments.push({ type: 'attachment', value: displayedMention, collapsed: !expanded });
    visibleText += displayedMention;
    sourceOffset = mention.end;
  }

  const remainingText = text.slice(sourceOffset);
  if (safeCursor !== undefined && cursorPrefix === undefined) {
    cursorPrefix = visibleText + text.slice(sourceOffset, safeCursor);
  }
  appendTextSegment(segments, remainingText);

  return { segments, cursorPrefix, cursorTouchesAttachment };
}

function findAttachmentMentions(text: string, attachmentPaths: readonly string[]): AttachmentMention[] {
  const mentions: AttachmentMention[] = [];
  for (const path of attachmentPaths) {
    const value = `@${path}`;
    for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) {
      const before = text[start - 1];
      const end = start + value.length;
      const after = text[end];
      if ((before === undefined || /\s/u.test(before)) && (after === undefined || /\s/u.test(after))) {
        mentions.push({ start, end, value, collapsedValue: `@${fileName(path)}` });
      }
    }
  }
  mentions.sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: AttachmentMention[] = [];
  for (const mention of mentions) {
    if (mention.start >= (nonOverlapping.at(-1)?.end ?? 0)) nonOverlapping.push(mention);
  }
  return nonOverlapping;
}

function appendTextSegment(segments: PromptTextSegment[], value: string): void {
  if (!value) return;
  segments.push({ type: 'text', value });
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) || path;
}
