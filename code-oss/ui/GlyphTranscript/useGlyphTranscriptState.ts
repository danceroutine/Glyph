import { toGlyphTranscriptParts } from '#src/desktop/workbench/toGlyphTranscriptParts.js';
import type { GlyphContextActions } from '#src/desktop/workbench/GlyphContextActions.js';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface GlyphTranscriptStateOptions {
  readonly context?: GlyphContextActions | undefined;
  readonly entries: readonly GlyphTranscriptEntry[];
}

export type GlyphTranscriptState = ReturnType<typeof useGlyphTranscriptState>;

export function useGlyphTranscriptState({ entries, context }: GlyphTranscriptStateOptions) {
  const [attachmentError, setAttachmentError] = useState<{ id: string; message: string }>();
  const open = async (id: string, attachment: GlyphAttachmentPreview) => {
    setAttachmentError(undefined);
    try {
      await context?.openAttachment(attachment);
    } catch (error) {
      setAttachmentError({ id, message: error instanceof Error ? error.message : String(error) });
    }
  };
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return {
    transcript,
    entries: entries.map(entry => ({
      ...entry,
      label: roleLabel(entry.role),
      attachmentError: attachmentError?.id === entry.id ? attachmentError.message : undefined,
      openAttachment: (attachment: GlyphAttachmentPreview) => void open(entry.id, attachment),
      parts: toGlyphTranscriptParts(entry).map(part =>
        part.type === 'text'
          ? part
          : {
              ...part,
              label: `${part.attachment.path.split('/').at(-1)}${part.attachment.range ? ` (${part.attachment.range.start.line}-${part.attachment.range.end.line})` : ''}`,
              title: `${part.attachment.path}${part.attachment.range ? ` (${part.attachment.range.start.line}-${part.attachment.range.end.line})` : ''}`,
            },
      ),
      ...(entry.progress
        ? { progress: { ...entry.progress, tools: entry.progress.tools.filter(tool => !tool.shell) } }
        : {}),
      shellActivities: (entry.progress?.tools ?? []).filter(
        (tool): tool is GlyphToolActivity & { readonly shell: GlyphShellCommand } => tool.shell !== undefined,
      ),
    })),
  };
}

function roleLabel(role: GlyphTranscriptRole): string {
  switch (role) {
    case GlyphTranscriptRole.USER:
      return 'You';
    case GlyphTranscriptRole.ASSISTANT:
      return 'Glyph';
    case GlyphTranscriptRole.DIAGNOSTIC:
      return 'Status';
  }
}
