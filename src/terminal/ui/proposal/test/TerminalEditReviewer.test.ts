import { highlight } from 'cli-highlight';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditProposal } from '../../../../editing/proposals/EditProposal.ts';
import { EditOperation } from '../../../../editing/proposals/EditOperation.ts';
import type { FileEditPlan } from '../../../../editing/proposals/FileEditPlan.ts';
import { EditDecisionState } from '../../../../editing/reviews/EditDecisionState.ts';
import type { EditReviewItem } from '../../../../editing/reviews/EditReviewItem.ts';
import { EditReviewItemKind } from '../../../../editing/reviews/EditReviewItemKind.ts';
import type { ProposalReviewManager } from '../../../../editing/reviews/ProposalReviewManager.ts';
import type { TerminalUI } from '../../../TerminalUI.tsx';
import {
  mergeReviewEntries,
  pendingEntries,
  renderEntry,
  ReviewViewMode,
  reviewEntries,
  TerminalEditReviewer,
} from '../TerminalEditReviewer.ts';
import { createProposalReviewFixture } from './ProposalReviewFixture.ts';

vi.mock('cli-highlight', async () => {
  const actual = await vi.importActual<typeof import('cli-highlight')>('cli-highlight');
  return { ...actual, highlight: vi.fn(actual.highlight) };
});

const highlightMock = vi.mocked(highlight);

afterEach(() => {
  highlightMock.mockClear();
});

describe(TerminalEditReviewer, () => {
  it('delegates reviews with explicit and default interrupt handlers', async () => {
    const reviewProposals = vi.fn<TerminalUI['reviewProposals']>(async () => {});
    const terminal = { reviewProposals } as unknown as TerminalUI;
    const manager = {} as ProposalReviewManager;
    const signal = new AbortController().signal;
    const interrupt = vi.fn();

    await new TerminalEditReviewer(terminal, interrupt).review(manager, signal);
    await new TerminalEditReviewer(terminal).review(manager, signal);
    const defaultInterrupt = reviewProposals.mock.calls[1]![2];
    defaultInterrupt();

    expect(reviewProposals.mock.calls[0]).toEqual([manager, signal, interrupt]);
    expect(reviewProposals).toHaveBeenCalledTimes(2);
  });
});

describe('proposal review entries', () => {
  it('numbers, filters, and merges entries across proposals', () => {
    const fixture = createProposalReviewFixture();
    const first = fixture.proposal.files[0]!.items[0]!;
    const second = { ...first, id: 'second', decision: EditDecisionState.ACCEPTED };
    fixture.proposal.files[0]!.items.push(second);
    const proposalTwo: EditProposal = {
      ...fixture.proposal,
      id: 'proposal-two',
      files: [
        {
          ...fixture.proposal.files[0]!,
          id: 'file-two',
          items: [{ ...first, id: 'third', fileId: 'file-two' }],
        },
      ],
    };

    const entries = reviewEntries([fixture.proposal, proposalTwo]);
    const pending = pendingEntries([fixture.proposal, proposalTwo]);
    const merged = mergeReviewEntries(entries.slice(0, 1), [fixture.proposal, proposalTwo]);

    expect(entries.map(entry => [entry.fileNumber, entry.changeNumber])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(pending.map(entry => entry.item.id)).toEqual(['item', 'third']);
    expect(merged.map(entry => entry.item.id)).toEqual(['item', 'second', 'third']);
  });
});

describe(renderEntry, () => {
  it('renders focused and full-file rename views, including an empty file', () => {
    const { file, item } = reviewFixture();
    const rename = { ...item, kind: EditReviewItemKind.RENAME };
    const renamedFile = {
      ...file,
      operation: EditOperation.RENAME,
      sourcePath: 'old.ts',
      targetPath: 'new.ts',
      base: null,
      items: [rename],
    };

    const focused = renderEntry(renamedFile, rename, ReviewViewMode.FOCUSED, false);
    const full = renderEntry(renamedFile, rename, ReviewViewMode.FULL_FILE, false);

    expect(focused.lines).toContain('Rename path');
    expect(full.lines).toContain('  <empty file>');
    expect(full.lines[0]).toContain('old.ts → new.ts');
  });

  it('renders create and delete files with every exact line ending', () => {
    const { file, item } = reviewFixture();
    const created = {
      ...item,
      kind: EditReviewItemKind.CREATE,
      insertedText: 'FROM node\t \r\nRUN echo hi\rCMD done',
    };
    const createFile = {
      ...file,
      operation: EditOperation.CREATE,
      sourcePath: 'Dockerfile',
      targetPath: 'Dockerfile',
      base: null,
      items: [created],
    };
    const deleted = { ...item, kind: EditReviewItemKind.DELETE, removedText: 'all gone\n' };
    const deleteFile = {
      ...file,
      operation: EditOperation.DELETE,
      sourcePath: 'Makefile',
      targetPath: 'Makefile',
      items: [deleted],
    };

    const createLines = renderEntry(createFile, created, ReviewViewMode.FULL_FILE, true).lines.join('\n');
    const deleteLines = renderEntry(deleteFile, deleted, ReviewViewMode.FULL_FILE, false).lines.join('\n');

    expect(createLines).toContain('↵CRLF');
    expect(createLines).toContain('↵CR');
    expect(createLines).toContain('␄ no final newline');
    expect(createLines).toContain('→···');
    expect(deleteLines).toContain('↵');
  });

  it('focuses a later text edit and marks hidden context above and below', () => {
    const { file, item } = reviewFixture();
    const text = Array.from({ length: 16 }, (_, index) => `line ${index}\n`).join('');
    const firstStart = text.indexOf('line 8');
    const secondStart = text.indexOf('line 10');
    const first = {
      ...item,
      id: 'first',
      sourceStart: firstStart,
      sourceEnd: firstStart + 'line 8'.length,
      removedText: 'line 8',
      insertedText: 'first change',
    };
    const second = {
      ...item,
      id: 'second',
      sourceStart: secondStart,
      sourceEnd: secondStart + 'line 10'.length,
      removedText: 'line 10',
      insertedText: 'second change',
    };
    const textFile = {
      ...file,
      base: { ...file.base!, text },
      sourcePath: 'notes.unknown',
      targetPath: 'notes.unknown',
      items: [first, second],
    };

    const rendered = renderEntry(textFile, second, ReviewViewMode.FOCUSED, false).lines.join('\n');

    expect(rendered).toContain('diff lines above');
    expect(rendered).toContain('diff lines below');
    expect(rendered).toContain('·-');
  });

  it('falls back when syntax highlighting fails and handles extensionless paths', () => {
    const { file, item } = reviewFixture();
    const created = { ...item, kind: EditReviewItemKind.CREATE, insertedText: 'const answer = 42;\n' };
    const createFile = { ...file, base: null, items: [created] };
    highlightMock.mockImplementationOnce(() => {
      throw new Error('highlight failed');
    });

    expect(renderEntry(createFile, created, ReviewViewMode.FULL_FILE, true).lines.join('\n')).toContain('const answer');
    expect(
      renderEntry({ ...createFile, sourcePath: 'path/', targetPath: 'path/' }, created, ReviewViewMode.FULL_FILE, true)
        .lines,
    ).not.toHaveLength(0);
  });
});

function reviewFixture(): { file: FileEditPlan; item: EditReviewItem } {
  const proposal = createProposalReviewFixture().proposal;
  return { file: proposal.files[0]!, item: proposal.files[0]!.items[0]! };
}
