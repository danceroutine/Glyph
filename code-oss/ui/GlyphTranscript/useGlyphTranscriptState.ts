import { toGlyphTranscriptParts } from '#src/desktop/workbench/toGlyphTranscriptParts.js';
import type { GlyphContextActions } from '#src/desktop/workbench/GlyphContextActions.js';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface GlyphTranscriptStateOptions {
  readonly branch?: ((turnId: string) => Promise<void>) | undefined;
  readonly restore?: ((turnId: string) => Promise<void>) | undefined;
  readonly context?: GlyphContextActions | undefined;
  readonly openLink?: ((href: string) => Promise<void>) | undefined;
  readonly entries: readonly GlyphTranscriptEntry[];
}

export type GlyphTranscriptState = ReturnType<typeof useGlyphTranscriptState>;

export function useGlyphTranscriptState({ entries, context, openLink, branch, restore }: GlyphTranscriptStateOptions) {
  const [historyPending, setHistoryPending] = useState(false);
  const [attachmentError, setAttachmentError] = useState<{ id: string; message: string }>();
  const open = async (id: string, attachment: GlyphAttachmentPreview) => {
    setAttachmentError(undefined);
    try {
      await context?.openAttachment(attachment);
    } catch (error) {
      setAttachmentError({ id, message: error instanceof Error ? error.message : String(error) });
    }
  };
  const historyAction = (entry: GlyphTranscriptEntry, action: ((turnId: string) => Promise<void>) | undefined) => {
    if (!action || !entry.checkpointTurnId || historyPending) return;
    setHistoryPending(true);
    setAttachmentError(undefined);
    void action(entry.checkpointTurnId)
      .catch(error =>
        setAttachmentError({ id: entry.id, message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setHistoryPending(false));
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
      historyPending,
      branch: branch && entry.checkpointTurnId ? () => historyAction(entry, branch) : undefined,
      restore: restore && entry.checkpointTurnId ? () => historyAction(entry, restore) : undefined,
      attachmentError: attachmentError?.id === entry.id ? attachmentError.message : undefined,
      copy: () => {
        void navigator.clipboard
          .writeText(entry.text)
          .catch(error => setAttachmentError({ id: entry.id, message: String(error) }));
      },
      openLink: (href: string) => {
        void (
          openLink
            ? openLink(href)
            : /^https?:\/\//i.test(href)
              ? Promise.resolve(window.open(href, '_blank', 'noopener,noreferrer'))
              : (context?.openAttachment({ path: href }) ?? Promise.resolve())
        ).catch(error => setAttachmentError({ id: entry.id, message: String(error) }));
      },
      datetime:
        entry.createdAt && Number.isFinite(Date.parse(entry.createdAt))
          ? new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : undefined,
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
