import { describe, expect, it } from 'vitest';
import { planTextRevert, type AppliedTextEdit } from '#src/editing/reviews/AppliedTextEdit.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';

function snapshot(text: string, byteOrderMark = false): WorkspaceTextSnapshot {
  return {
    path: 'file.txt',
    text,
    byteOrderMark,
    revision: `revision:${text}`,
    byteLength: Buffer.byteLength(text) + (byteOrderMark ? 3 : 0),
    mode: 0o644,
    identity: 'fixture:file.txt',
  };
}

describe(planTextRevert, () => {
  it('declines to plan a revert when the original content was never observed', () => {
    const edit: AppliedTextEdit = { state: 'applied', before: null, after: snapshot('b\n'), revertTarget: null };

    expect(planTextRevert(edit, snapshot('b\n'))).toBeUndefined();
  });

  it('declines to plan a revert when the applied content was never observed', () => {
    const edit: AppliedTextEdit = { state: 'applying', before: snapshot('a\n'), after: null, revertTarget: null };

    expect(planTextRevert(edit, snapshot('a\n'))).toBeUndefined();
  });

  it('reverses only the applied edit while preserving disjoint later edits', () => {
    const edit: AppliedTextEdit = {
      state: 'applied',
      before: snapshot('one\nmiddle\nthree\n'),
      after: snapshot('ONE\nmiddle\nthree\n'),
      revertTarget: null,
    };

    expect(planTextRevert(edit, snapshot('ONE\nmiddle\nuser\n', true))).toEqual({
      text: 'one\nmiddle\nuser\n',
      byteOrderMark: true,
    });
  });

  it('declines to plan a revert over an overlapping later edit', () => {
    const edit: AppliedTextEdit = {
      state: 'applied',
      before: snapshot('one\nmiddle\nthree\n'),
      after: snapshot('ONE\nmiddle\nthree\n'),
      revertTarget: null,
    };

    expect(planTextRevert(edit, snapshot('LATEST\nmiddle\nthree\n'))).toBeUndefined();
  });

  it('restores the original encoding marker when the applied encoding is still present', () => {
    const edit: AppliedTextEdit = {
      state: 'applied',
      before: snapshot('text\n'),
      after: snapshot('text\n', true),
      revertTarget: null,
    };

    expect(planTextRevert(edit, snapshot('text\nmore\n', true))).toEqual({
      text: 'text\nmore\n',
      byteOrderMark: false,
    });
  });

  it('declines to plan an encoding revert after the encoding marker was changed again', () => {
    const edit: AppliedTextEdit = {
      state: 'applied',
      before: snapshot('text\n'),
      after: snapshot('text\n', true),
      revertTarget: null,
    };

    expect(planTextRevert(edit, snapshot('text\n'))).toBeUndefined();
  });
});
