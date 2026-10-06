import { useEffect, useState } from 'react';
import { useInput, useWindowSize } from 'ink';
import { EditDecisionState } from '../../editing/reviews/EditDecisionState.ts';
import {
  clamp,
  pendingEntries,
  renderEntry,
  ReviewViewMode,
  sanitizeText,
  wrapReviewLines,
} from '../TerminalEditReviewer.ts';
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
  const entries = pendingEntries(request.manager.activeReviews);
  const [selection, setSelection] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [viewMode, setViewMode] = useState(ReviewViewMode.FOCUSED);
  const [diagnostic, setDiagnostic] = useState('');
  const [busy, setBusy] = useState(false);
  const { columns, rows } = useWindowSize();
  const selectedIndex = clamp(selection, 0, Math.max(0, entries.length - 1));
  const entry = entries[selectedIndex];
  const rendered = entry
    ? wrapReviewLines(
        renderEntry(entry.file, entry.item, viewMode, process.env.NO_COLOR === undefined),
        Math.max(38, columns - 2),
      )
    : { lines: [], focusLine: 0 };
  const diagnosticLines = diagnostic ? 1 : 0;
  const pageSize = Math.max(3, rows - 4 - diagnosticLines);
  const maxScroll = Math.max(0, rendered.lines.length - pageSize);
  const visibleScroll = clamp(scroll, 0, maxScroll);

  useEffect(() => {
    if (entries.length === 0) request.complete();
  }, [entries.length, request]);

  useEffect(() => {
    setSelection(value => clamp(value, 0, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  useEffect(() => {
    setScroll(clamp(rendered.focusLine - Math.floor(pageSize / 3), 0, maxScroll));
  }, [entry?.item.id, maxScroll, pageSize, rendered.focusLine, viewMode]);

  const decide = (decision: EditDecisionState): void => {
    if (!entry || busy) return;
    setBusy(true);
    const operation =
      decision === EditDecisionState.ACCEPTED
        ? request.manager.acceptInReview(entry.review.id, entry.item.id)
        : request.manager.rejectInReview(entry.review.id, entry.item.id);
    void operation
      .then(() => {
        setDiagnostic('');
        if (request.manager.activeReviews.length === 0) request.complete();
        else {
          setSelection(value => Math.min(value, Math.max(0, pendingEntries(request.manager.activeReviews).length - 1)));
        }
      })
      .catch((error: unknown) => setDiagnostic(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input.toLowerCase() === 'c') {
      request.interrupt();
      request.complete();
      return;
    }
    if (key.escape || input.toLowerCase() === 'q') {
      request.complete();
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
    else if (key.rightArrow) setSelection(value => Math.min(entries.length - 1, value + 1));
    else if (key.leftArrow) setSelection(value => Math.max(0, value - 1));
    else if (input.toLowerCase() === 'f') {
      setViewMode(value => (value === ReviewViewMode.FOCUSED ? ReviewViewMode.FULL_FILE : ReviewViewMode.FOCUSED));
    }
  });

  if (!entry) {
    return {
      rows,
      header: 'Review complete.',
      diagnostic: '',
      visibleLines: [],
      navigationHelp: '',
      decisionHelp: '',
      complete: true,
    };
  }

  const reviewItems = request.manager.activeReviews.flatMap(review => review.files).flatMap(file => file.items);
  const accepted = reviewItems.filter(item => item.decision === EditDecisionState.ACCEPTED).length;
  const rejected = reviewItems.filter(item => item.decision === EditDecisionState.REJECTED).length;
  const mode = viewMode === ReviewViewMode.FULL_FILE ? 'full file' : 'focused diff';
  const firstVisibleLine = rendered.lines.length === 0 ? 0 : visibleScroll + 1;
  const lastVisibleLine = Math.min(rendered.lines.length, visibleScroll + pageSize);
  const viewAction = viewMode === ReviewViewMode.FULL_FILE ? 'focused diff' : 'full file';

  return {
    rows,
    header: `File ${entry.fileNumber}/${entry.fileCount}  change ${entry.changeNumber}/${entry.changeCount}  accepted ${accepted}  rejected ${rejected}  •  ${mode}  •  view ${firstVisibleLine}–${lastVisibleLine}/${rendered.lines.length}`,
    diagnostic: diagnostic ? `Error: ${sanitizeText(diagnostic)}` : '',
    visibleLines: rendered.lines.slice(visibleScroll, visibleScroll + pageSize),
    navigationHelp: `↑/↓ scroll  PgUp/PgDn page  Home/End top/bottom  F ${viewAction}`,
    decisionHelp: `←/→ previous/next change  Y accept  N reject  Esc/Q defer${busy ? '  applying…' : ''}`,
    complete: false,
  };
}
