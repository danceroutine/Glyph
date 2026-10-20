import { toGlyphTranscriptParts } from '#src/desktop/workbench/toGlyphTranscriptParts.js';
import { toGlyphPlanBuildLead } from '#src/desktop/workbench/GlyphPlanPrompt.js';
import type { GlyphContextActions } from '#src/desktop/workbench/GlyphContextActions.js';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { useState } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface GlyphMessageStateOptions {
  readonly branch?: ((turnId: string) => Promise<void>) | undefined;
  readonly restore?: ((turnId: string) => Promise<void>) | undefined;
  readonly context?: GlyphContextActions | undefined;
  readonly copyText?: ((text: string) => Promise<void>) | undefined;
  readonly openLink?: ((href: string) => Promise<void>) | undefined;
  readonly entries: readonly GlyphTranscriptEntry[];
}

export type GlyphMessageState = ReturnType<typeof useGlyphMessageState>;

export function useGlyphMessageState({
  entries,
  context,
  openLink,
  branch,
  restore,
  copyText = text => navigator.clipboard.writeText(text),
}: GlyphMessageStateOptions) {
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
  return {
    entries: entries.map(entry => ({
      ...entry,
      label: roleLabel(entry.role),
      historyPending,
      branch: branch && entry.checkpointTurnId ? () => historyAction(entry, branch) : undefined,
      restore: restore && entry.checkpointTurnId ? () => historyAction(entry, restore) : undefined,
      attachmentError: attachmentError?.id === entry.id ? attachmentError.message : undefined,
      copyText,
      copy: () => {
        void copyText(entry.text).catch(error => setAttachmentError({ id: entry.id, message: String(error) }));
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
      parts: toGlyphTranscriptParts(
        entry.options?.planBuild
          ? { ...entry, text: toGlyphPlanBuildLead(entry.text, entry.options.planBuild) }
          : entry,
      ).map(part =>
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
