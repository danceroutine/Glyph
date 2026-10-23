import { describe, expect, it } from 'vitest';
import { toGlyphProposalFilePreview } from '#src/desktop/host/toGlyphProposalFilePreview.js';
import type { FileEditPlanRecord } from '#src/editing/proposals/FileEditPlan.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';

const snapshot = {
  path: 'file.ts',
  identity: '/workspace/file.ts',
  text: 'first\r\n🌱\r\nlast\r\n',
  byteOrderMark: false,
  revision: 'current',
  byteLength: 21,
  mode: 0o644,
};
function plan(): FileEditPlanRecord {
  return {
    id: 'file',
    operation: EditOperation.UPDATE,
    sourcePath: 'file.ts',
    targetPath: 'file.ts',
    base: snapshot,
    current: snapshot,
    proposed: { ...snapshot, text: 'an outdated complete proposal' },
    applyingItemId: null,
    createdDirectories: [],
    applicability: EditApplicabilityState.READY,
    currentPath: 'file.ts',
    currentRevision: 'current',
    items: [
      {
        id: 'last',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 11,
        sourceEnd: 17,
        removedText: 'last\r\n',
        insertedText: 'LAST\r\n',
        decision: EditDecisionState.PENDING,
      },
      {
        id: 'first',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 0,
        sourceEnd: 7,
        removedText: 'first\r\n',
        insertedText: 'FIRST\r\nextra\r\n',
        decision: EditDecisionState.PENDING,
      },
      {
        id: 'rejected',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 7,
        sourceEnd: 11,
        removedText: '🌱\r\n',
        insertedText: 'discarded\r\n',
        decision: EditDecisionState.REJECTED,
      },
    ],
  };
}

describe(toGlyphProposalFilePreview, () => {
  it('composes only pending items and locates them after preceding insertions without splitting Unicode or CRLF', () => {
    expect(toGlyphProposalFilePreview('proposal', plan())).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: snapshot.text,
      after: 'FIRST\r\nextra\r\n🌱\r\nLAST\r\n',
      items: [
        { id: 'first', lineNumber: 1 },
        { id: 'last', lineNumber: 4 },
      ],
    });
  });
  it('uses the current accepted baseline instead of the original proposal text', () => {
    const file = plan();
    file.items[1]!.decision = EditDecisionState.ACCEPTED;
    file.current = { ...snapshot, text: 'FIRST\r\n🌱\r\nlast\r\n' };
    const preview = toGlyphProposalFilePreview('proposal', file);
    expect(preview.before).toBe(file.current.text);
    expect(preview.after).toBe('FIRST\r\n🌱\r\nLAST\r\n');
    expect(preview.items).toEqual([{ id: 'last', lineNumber: 3 }]);
  });

  it('reverts pending immediate edits from the live file and locates them in the current text', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      current: text('ONE\ntwo\nthree\n'),
      items: [
        {
          id: 'upper',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 3,
          removedText: 'one',
          insertedText: 'ONE',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: text('one\ntwo\n'), after: text('ONE\ntwo\n'), revertTarget: null },
        },
        {
          id: 'untracked',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 4,
          sourceEnd: 7,
          removedText: 'two',
          insertedText: 'two',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: null, after: text('ONE\ntwo\n'), revertTarget: null },
        },
        {
          id: 'moved',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 2,
          sourceEnd: 2,
          removedText: '',
          insertedText: 'longer than the observed text',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: null, after: text('x'), revertTarget: null },
        },
        {
          id: 'kept',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 8,
          sourceEnd: 8,
          removedText: '',
          insertedText: 'three\n',
          decision: EditDecisionState.PENDING,
          appliedText: {
            state: 'kept',
            before: text('ONE\ntwo\n'),
            after: text('ONE\ntwo\nthree\n'),
            revertTarget: null,
          },
        },
        {
          id: 'unapplied',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: 'zero\n',
          decision: EditDecisionState.PENDING,
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: 'one\ntwo\nthree\n',
      after: 'ONE\ntwo\nthree\n',
      items: [
        { id: 'upper', lineNumber: 1 },
        { id: 'untracked', lineNumber: 2 },
        { id: 'moved', lineNumber: 1 },
      ],
    });
  });

  it('leads with a pending automatic change and shows its original text as the baseline', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      operation: EditOperation.RENAME,
      current: text('body\n'),
      automatic: { itemId: 'rename', before: text('original\n'), state: 'applied', appliedRevision: 'body\n' },
      items: [
        {
          id: 'rename',
          fileId: 'file',
          kind: EditReviewItemKind.RENAME,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: '',
          decision: EditDecisionState.PENDING,
        },
        {
          id: 'edit',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 4,
          removedText: 'text',
          insertedText: 'body',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: text('text\n'), after: text('body\n'), revertTarget: null },
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: 'original\n',
      after: 'body\n',
      items: [
        { id: 'rename', lineNumber: 1 },
        { id: 'edit', lineNumber: 1 },
      ],
    });
  });

  it('omits a kept automatic change from the immediate-edit preview', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      current: text('body\n'),
      automatic: { itemId: 'create', before: null, state: 'kept', appliedRevision: 'text\n' },
      items: [
        {
          id: 'create',
          fileId: 'file',
          kind: EditReviewItemKind.CREATE,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: '',
          decision: EditDecisionState.ACCEPTED,
        },
        {
          id: 'edit',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 4,
          removedText: 'text',
          insertedText: 'body',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: text('text\n'), after: text('body\n'), revertTarget: null },
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: 'text\n',
      after: 'body\n',
      items: [{ id: 'edit', lineNumber: 1 }],
    });
  });

  it('previews an applied deletion as removing the original file', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      operation: EditOperation.DELETE,
      current: null,
      automatic: { itemId: 'delete', before: text('gone\n'), state: 'applied', appliedRevision: null },
      items: [
        {
          id: 'delete',
          fileId: 'file',
          kind: EditReviewItemKind.DELETE,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: '',
          decision: EditDecisionState.PENDING,
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: 'gone\n',
      after: '',
      items: [{ id: 'delete', lineNumber: 1 }],
    });
  });

  it('previews an applied creation with its pending text hunks', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      operation: EditOperation.CREATE,
      base: null,
      current: null,
      proposed: text('new\nfile\n'),
      automatic: { itemId: 'create', before: null, state: 'applied', appliedRevision: 'new\nfile\n' },
      items: [
        {
          id: 'create',
          fileId: 'file',
          kind: EditReviewItemKind.CREATE,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: '',
          decision: EditDecisionState.PENDING,
        },
        {
          id: 'hunk',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 4,
          sourceEnd: 4,
          removedText: '',
          insertedText: 'file\n',
          decision: EditDecisionState.PENDING,
          appliedText: { state: 'applied', before: null, after: text('new\nfile\n'), revertTarget: null },
        },
        {
          id: 'rejected',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: 'nope',
          decision: EditDecisionState.REJECTED,
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: '',
      after: 'new\nfile\n',
      items: [
        { id: 'create', lineNumber: 1 },
        { id: 'hunk', lineNumber: 1 },
      ],
    });
  });

  it('locates pending hunks against the base while an automatic change is still being applied', () => {
    const text = (value: string) => ({ ...snapshot, text: value, revision: value });
    const file: FileEditPlanRecord = {
      ...plan(),
      base: text('a\nb\n'),
      current: null,
      automatic: { itemId: 'rename', before: null, state: 'applying', appliedRevision: null },
      items: [
        {
          id: 'b',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 2,
          sourceEnd: 3,
          removedText: 'b',
          insertedText: 'B',
          decision: EditDecisionState.PENDING,
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: 'a\nb\n',
      after: 'a\nB\n',
      items: [{ id: 'b', lineNumber: 2 }],
    });
  });

  it('starts from an empty file when there is neither a current nor a base snapshot', () => {
    const file: FileEditPlanRecord = {
      ...plan(),
      base: null,
      current: null,
      items: [
        {
          id: 'insert',
          fileId: 'file',
          kind: EditReviewItemKind.TEXT,
          sourceStart: 0,
          sourceEnd: 0,
          removedText: '',
          insertedText: 'hello',
          decision: EditDecisionState.PENDING,
        },
      ],
    };
    expect(toGlyphProposalFilePreview('proposal', file)).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: '',
      after: 'hello',
      items: [{ id: 'insert', lineNumber: 1 }],
    });
  });
});
