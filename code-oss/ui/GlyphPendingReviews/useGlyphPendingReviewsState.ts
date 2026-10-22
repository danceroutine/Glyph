import { useId, useRef, useState } from 'preact/hooks';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export interface GlyphPendingReviewsStateOptions {
  readonly chatId: string;
  readonly proposals: readonly GlyphProposalSummary[];
  readonly readOnly: boolean;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'reviewProposalFile' | 'decideProposalItems'>;
}
export type GlyphPendingReviewsState = ReturnType<typeof useGlyphPendingReviewsState>;

export function useGlyphPendingReviewsState({ chatId, proposals, readOnly, actions }: GlyphPendingReviewsStateOptions) {
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const listId = useId();
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const files = proposals
    .filter(proposal => proposal.chatId === chatId)
    .flatMap(proposal =>
      proposal.files
        .filter(file => file.pendingItemIds.length > 0)
        .map(file => ({
          ...file,
          proposalId: proposal.id,
          key: `${proposal.id}/${file.id}`,
          name: file.path.slice(file.path.lastIndexOf('/') + 1),
          canKeep:
            (file.textOnly === true || file.autoApplied === true) &&
            [GlyphProposalApplicability.READY, GlyphProposalApplicability.FAILED_RETRYABLE].includes(
              file.applicability,
            ),
          status:
            file.applicability === GlyphProposalApplicability.STALE
              ? 'File changed. Revert newer edits first, or keep this change.'
              : file.textOnly === false && file.autoApplied !== true
                ? 'The file operation could not be applied. Revert to dismiss it.'
                : undefined,
        })),
    );
  const decide = (selected: typeof files, accept: boolean) =>
    perform(() =>
      actions.decideProposalItems(
        chatId,
        selected.flatMap(file => file.pendingItemIds.map(itemId => ({ proposalId: file.proposalId, itemId }))),
        accept,
      ),
    );
  return {
    files: files.map(file => ({
      ...file,
      review: () => perform(() => actions.reviewProposalFile(chatId, file.proposalId, file.id)),
      keep: () => decide([file], true),
      undo: () => decide([file], false),
    })),
    expanded,
    listId,
    error,
    busy: pending,
    disabled: readOnly || pending,
    keepDisabled: readOnly || pending || files.some(file => !file.canKeep),
    summary: `${files.length} ${files.length === 1 ? 'File' : 'Files'}`,
    keepLabel: files.length === 1 ? 'Keep' : 'Keep All',
    undoLabel: files.length === 1 ? 'Revert' : 'Revert All',
    toggle: () => {
      setExpanded(value => !value);
    },
    keep: () => decide(files, true),
    undo: () => decide(files, false),
    review: () =>
      perform(async () => {
        const file = files[0];
        if (file) await actions.reviewProposalFile(chatId, file.proposalId, file.id);
      }),
  };
}
