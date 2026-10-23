import { isReviewItemPending } from '#src/editing/reviews/isReviewItemPending.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInput, useWindowSize } from 'ink';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import {
  clamp,
  mergeReviewEntries,
  pendingReviewEntries,
  renderEntry,
  ReviewViewMode,
  wrapReviewLines,
} from './TerminalEditReviewer.ts';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';
import type { ProposalReviewRequest } from './ProposalReviewRequest.ts';

/** Complete rendering contract produced by the proposal-review state hook. */
export interface ProposalReviewState {
  rows: number;
  header: string;
  diagnostic: string;
  visibleLines: readonly string[];
  navigationHelp: string;
  decisionHelp: string;
  complete: boolean;
}

export function useProposalReviewState(request: ProposalReviewRequest): ProposalReviewState {
  const queue = useRef<ReturnType<typeof mergeReviewEntries>>([]);
  queue.current = mergeReviewEntries(queue.current, request.manager.activeReviews);
  const entries = pendingReviewEntries(queue.current);
  const totals = useRef(countDecisions(request.manager.activeReviews));
  const completionSent = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [selection, setSelection] = useState(0);
  const currentSelection = useRef(0);
  const [scroll, setScroll] = useState(0);
  const [viewMode, setViewMode] = useState(ReviewViewMode.FOCUSED);
  const [diagnostic, setDiagnostic] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingOperation = useRef(false);
  const select = useCallback((value: number): void => {
    currentSelection.current = value;
    setSelection(value);
  }, []);
  const setPending = useCallback((value: boolean): void => {
    pendingOperation.current = value;
    if (mounted.current) setBusy(value);
  }, []);
  const { columns, rows } = useWindowSize();
  const selectedIndex = clamp(selection, 0, Math.max(0, entries.length - 1));
  const entry = entries[selectedIndex];
  const rendered = entry
    ? wrapReviewLines(
        renderEntry(entry.file, entry.item, viewMode, process.env.NO_COLOR === undefined),
        Math.max(1, columns - 2),
      )
    : { lines: [], focusLine: 0 };
  const diagnosticLines = diagnostic ? 1 : 0;
  const pageSize = Math.max(1, rows - 4 - diagnosticLines);
  const maxScroll = Math.max(0, rendered.lines.length - pageSize);
  const visibleScroll = clamp(scroll, 0, maxScroll);
  const completeReview = useCallback((): void => {
    if (!mounted.current || completionSent.current) return;
    completionSent.current = true;
    request.complete({ ...totals.current });
  }, [request]);

  const retryPersistence = useCallback((): void => {
    if (pendingOperation.current || completionSent.current || !mounted.current) return;
    setPending(true);
    void request.manager
      .flushPendingCheckpoint()
      .then(() => {
        setDiagnostic('');
      })
      .catch((error: unknown) => {
        setDiagnostic(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setPending(false);
      });
  }, [request.manager, setPending]);

  useEffect(() => {
    if (busy || entries.length > 0) return;
    if (!request.manager.hasPendingCheckpoint) completeReview();
    else if (!diagnostic) retryPersistence();
  }, [busy, completeReview, entries.length, diagnostic, request.manager, retryPersistence]);

  useEffect(() => {
    select(clamp(currentSelection.current, 0, Math.max(0, entries.length - 1)));
  }, [entries.length, select]);

  useEffect(() => {
    setScroll(clamp(rendered.focusLine - Math.floor(pageSize / 3), 0, maxScroll));
  }, [entry?.item.id, maxScroll, pageSize, rendered.focusLine, viewMode]);

  const decide = (decision: EditDecisionState): void => {
    if (!mounted.current || completionSent.current || pendingOperation.current || !entry) return;
    // Navigation can precede a decision in the same input batch. Never decide
    // the previous entry, or a newly selected diff that has not rendered yet.
    if (entries[clamp(currentSelection.current, 0, Math.max(0, entries.length - 1))] !== entry) return;
    if (!isReviewItemPending(entry.file, entry.item)) return;
    setPending(true);
    const operation =
      decision === EditDecisionState.ACCEPTED
        ? request.manager.acceptInReview(entry.review.id, entry.item.id)
        : request.manager.rejectInReview(entry.review.id, entry.item.id);
    void operation
      .then(() => {
        if (!mounted.current || completionSent.current) return;
        setDiagnostic('');
        if (decision === EditDecisionState.ACCEPTED) totals.current.accepted++;
        else totals.current.rejected++;
        if (request.manager.activeReviews.length === 0) completeReview();
        else {
          select(Math.min(currentSelection.current, Math.max(0, pendingReviewEntries(queue.current).length - 1)));
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current || completionSent.current) return;
        // A failed checkpoint can follow a successful edit. Keep its decision
        // in the receipt totals while persistence remains visibly unfinished.
        totals.current = {
          accepted: queue.current.filter(
            value => !isReviewItemPending(value.file, value.item) && value.item.decision === EditDecisionState.ACCEPTED,
          ).length,
          rejected: queue.current.filter(
            value => !isReviewItemPending(value.file, value.item) && value.item.decision === EditDecisionState.REJECTED,
          ).length,
        };
        setDiagnostic(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setPending(false);
      });
  };

  useInput((input, key) => {
    if (!mounted.current || completionSent.current || pendingOperation.current || key.eventType === 'release') return;
    if (key.ctrl && input.toLowerCase() === 'c') {
      completionSent.current = true;
      request.interrupt();
      request.complete();
      return;
    }
    if (key.escape || input.toLowerCase() === 'q') {
      completionSent.current = true;
      request.complete();
      return;
    }
    if (input.toLowerCase() === 'r' && request.manager.hasPendingCheckpoint) {
      retryPersistence();
      return;
    }
    if (input.toLowerCase() === 'y') {
      decide(EditDecisionState.ACCEPTED);
      return;
    }
    if (input.toLowerCase() === 'n') {
      decide(EditDecisionState.REJECTED);
      return;
    }
    if (key.downArrow) setScroll(value => Math.min(maxScroll, value + 1));
    else if (key.upArrow) setScroll(value => Math.max(0, value - 1));
    else if (key.pageDown) setScroll(value => Math.min(maxScroll, value + pageSize));
    else if (key.pageUp) setScroll(value => Math.max(0, value - pageSize));
    else if (key.home) setScroll(0);
    else if (key.end) setScroll(maxScroll);
    else if (key.rightArrow) select(Math.min(entries.length - 1, currentSelection.current + 1));
    else if (key.leftArrow) select(Math.max(0, currentSelection.current - 1));
    else if (input.toLowerCase() === 'f') {
      setViewMode(value => (value === ReviewViewMode.FOCUSED ? ReviewViewMode.FULL_FILE : ReviewViewMode.FOCUSED));
    }
  });

  if (!entry) {
    if (request.manager.hasPendingCheckpoint) {
      return {
        rows,
        header: 'Review checkpoint pending',
        diagnostic: diagnostic ? `Error: ${sanitizeText(diagnostic)}` : '',
        visibleLines: ['The edit is applied, but its result has not been saved.'],
        navigationHelp: '',
        decisionHelp: busy ? 'Saving…' : 'R retry save  Esc/Q defer',
        complete: false,
      };
    }
    return {
      rows,
      header: `Review complete — ${totals.current.accepted} accepted, ${totals.current.rejected} rejected`,
      diagnostic: '',
      visibleLines: [],
      navigationHelp: '',
      decisionHelp: '',
      complete: true,
    };
  }

  const { accepted, rejected } = totals.current;
  const mode = viewMode === ReviewViewMode.FULL_FILE ? 'full file' : 'focused diff';
  const firstVisibleLine = visibleScroll + 1;
  const lastVisibleLine = Math.min(rendered.lines.length, visibleScroll + pageSize);
  const viewAction = viewMode === ReviewViewMode.FULL_FILE ? 'focused diff' : 'full file';

  return {
    rows,
    header: `File ${entry.fileNumber}/${entry.fileCount}  change ${entry.changeNumber}/${entry.changeCount}  accepted ${accepted}  rejected ${rejected}  •  ${mode}  •  view ${firstVisibleLine}–${lastVisibleLine}/${rendered.lines.length}`,
    diagnostic: diagnostic ? `Error: ${sanitizeText(diagnostic)}` : '',
    visibleLines: rendered.lines.slice(visibleScroll, visibleScroll + pageSize),
    navigationHelp: `↑/↓ scroll  PgUp/PgDn page  Home/End top/bottom  F ${viewAction}`,
    decisionHelp: `←/→ previous/next change  Y keep  N revert  Esc/Q defer${busy ? '  saving…' : ''}`,
    complete: false,
  };
}

function countDecisions(reviews: ProposalReviewRequest['manager']['activeReviews']): {
  accepted: number;
  rejected: number;
} {
  const items = reviews
    .flatMap(review => review.files)
    .flatMap(file => file.items.filter(item => !isReviewItemPending(file, item)));
  return {
    accepted: items.filter(item => item.decision === EditDecisionState.ACCEPTED).length,
    rejected: items.filter(item => item.decision === EditDecisionState.REJECTED).length,
  };
}
