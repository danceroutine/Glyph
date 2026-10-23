import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { WiredProposalReview } from '#src/terminal/ui/proposal/ProposalReview.wired.js';
import { createProposalReviewFixture } from './ProposalReviewFixture.ts';
import { normalize } from '#src/shared/tests/normalize.js';

describe(WiredProposalReview, () => {
  describe('interaction', () => {
    it('does not retry persistence after a deferred review receives an external decision', async () => {
      const fixture = createProposalReviewFixture();
      const flush = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(fixture.manager, 'hasPendingCheckpoint', { value: true });
      fixture.manager.flushPendingCheckpoint = flush;
      const complete = vi.fn();
      const request = { id: 1, manager: fixture.manager, complete, interrupt: vi.fn() };
      const view = render(<WiredProposalReview request={request} />);
      try {
        await tick();
        view.stdin.write('q');
        expect(complete).toHaveBeenCalledExactlyOnceWith();
        fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.REJECTED;
        view.rerender(<WiredProposalReview request={{ ...request }} />);
        await tick();
        expect(flush).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
      }
    });

    it.each([new Error('save unavailable'), 'save unavailable'])(
      'keeps a recovered decision open after a save failure and completes only after retry (%s)',
      async failure => {
        const fixture = createProposalReviewFixture();
        fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.ACCEPTED;
        let pending = true;
        let finish!: () => void;
        const flush = vi
          .fn()
          .mockRejectedValueOnce(failure)
          .mockImplementationOnce(
            () =>
              new Promise<void>(resolve => {
                finish = () => {
                  pending = false;
                  resolve();
                };
              }),
          );
        Object.defineProperty(fixture.manager, 'hasPendingCheckpoint', { get: () => pending });
        fixture.manager.flushPendingCheckpoint = flush;
        const complete = vi.fn();
        const request = { id: 1, manager: fixture.manager, complete, interrupt: vi.fn() };
        const view = render(<WiredProposalReview request={request} />);
        try {
          await vi.waitFor(() => {
            expect(view.lastFrame()).toContain('Error: save unavailable');
          });
          expect(view.lastFrame()).toContain('R retry save');
          expect(complete).not.toHaveBeenCalled();
          view.stdin.write('y');
          expect(fixture.accept).not.toHaveBeenCalled();
          view.stdin.write('r');
          view.stdin.write('r');
          await vi.waitFor(() => {
            expect(view.lastFrame()).toContain('Saving…');
          });
          expect(flush).toHaveBeenCalledTimes(2);
          expect(complete).not.toHaveBeenCalled();
          finish();
          await vi.waitFor(() => {
            expect(complete).toHaveBeenCalledExactlyOnceWith({ accepted: 1, rejected: 0 });
          });
          expect(view.lastFrame()).toContain('Review complete');
        } finally {
          finish?.();
          view.unmount();
        }
      },
    );

    it('ignores a decision already settled outside the displayed frame', async () => {
      const fixture = createProposalReviewFixture();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      try {
        await tick();
        fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.REJECTED;
        view.stdin.write('y');
        expect(fixture.accept).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it('ignores a rejected decision after its review has been replaced', async () => {
      const fixture = createProposalReviewFixture();
      const next = createProposalReviewFixture();
      let fail!: (error: Error) => void;
      fixture.accept.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      );
      const complete = vi.fn();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt: vi.fn() }} />,
      );
      try {
        await tick();
        view.stdin.write('y');
        view.rerender(
          <WiredProposalReview request={{ id: 2, manager: next.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
        );
        await tick();
        fail(new Error('old review failure'));
        await tick();
        expect(view.lastFrame()).not.toContain('old review failure');
        expect(complete).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it('does not decide the old or undisplayed change when navigation and acceptance arrive in one frame', async () => {
      const fixture = createProposalReviewFixture();
      const first = fixture.proposal.files[0]!.items[0]!;
      fixture.proposal.files[0]!.items.push({ ...first, id: 'second', sourceStart: 4, sourceEnd: 7 });
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      try {
        await tick();
        view.stdin.write('\u001B[C');
        view.stdin.write('y');
        expect(fixture.accept).not.toHaveBeenCalled();
        await tick();
        view.stdin.write('y');
        await expect.poll(() => fixture.accept.mock.calls.length === 1).toBe(true);
        expect(fixture.accept).toHaveBeenCalledWith('proposal', 'second');
      } finally {
        view.unmount();
      }
    });

    it('claims an in-flight decision synchronously before repeated or opposite decision keys', async () => {
      const fixture = createProposalReviewFixture();
      let finish!: () => void;
      fixture.accept.mockImplementation(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      const complete = vi.fn();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt: vi.fn() }} />,
      );
      try {
        await tick();
        view.stdin.write('y');
        view.stdin.write('y');
        view.stdin.write('n');
        view.stdin.write('q');
        expect(fixture.accept).toHaveBeenCalledTimes(1);
        expect(fixture.reject).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      } finally {
        finish?.();
        view.unmount();
      }
    });

    it.each(['q', '\u0003'])(
      'settles a deferred or interrupted review once and ignores later decisions (%j)',
      async key => {
        const fixture = createProposalReviewFixture();
        const complete = vi.fn();
        const interrupt = vi.fn();
        const view = render(<WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt }} />);
        try {
          await tick();
          view.stdin.write(key);
          view.stdin.write(key);
          view.stdin.write('y');
          expect(complete).toHaveBeenCalledTimes(1);
          expect(interrupt).toHaveBeenCalledTimes(key === '\u0003' ? 1 : 0);
          expect(fixture.accept).not.toHaveBeenCalled();
        } finally {
          view.unmount();
        }
      },
    );

    it('starts a replacement review with fresh selection, completion, and progress state', async () => {
      const first = createProposalReviewFixture();
      const next = createProposalReviewFixture();
      const complete = vi.fn();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: first.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      try {
        await tick();
        view.stdin.write('q');
        view.rerender(<WiredProposalReview request={{ id: 2, manager: next.manager, complete, interrupt: vi.fn() }} />);
        await tick();
        view.stdin.write('q');
        expect(complete).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
      }
    });

    it('does not complete a replaced review when its earlier decision finally finishes', async () => {
      const first = createProposalReviewFixture();
      const next = createProposalReviewFixture();
      const firstComplete = vi.fn();
      const nextComplete = vi.fn();
      let finish!: () => void;
      first.accept.mockImplementation(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      const view = render(
        <WiredProposalReview
          request={{ id: 1, manager: first.manager, complete: firstComplete, interrupt: vi.fn() }}
        />,
      );
      try {
        await tick();
        view.stdin.write('y');
        expect(first.accept).toHaveBeenCalledTimes(1);
        view.rerender(
          <WiredProposalReview
            request={{ id: 2, manager: next.manager, complete: nextComplete, interrupt: vi.fn() }}
          />,
        );
        await tick();
        (first.manager.activeReviews as EditProposal[]).splice(0);
        finish();
        await tick();
        expect(firstComplete).not.toHaveBeenCalled();
        expect(nextComplete).not.toHaveBeenCalled();
        view.stdin.write('q');
        expect(nextComplete).toHaveBeenCalledTimes(1);
      } finally {
        finish?.();
        view.unmount();
      }
    });

    it('completes an empty review', async () => {
      const complete = vi.fn();
      const fixture = createProposalReviewFixture();
      fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.REJECTED;
      const request = { id: 1, manager: fixture.manager, complete, interrupt: vi.fn() };
      const view = render(<WiredProposalReview request={request} />);

      await expect.poll(() => complete.mock.calls.length === 1).toBe(true);
      expect(complete).toHaveBeenCalledWith({ accepted: 0, rejected: 1 });
      expect(normalize(view.lastFrame()!)).toBe('Review complete — 0 accepted, 1 rejected');
      view.rerender(<WiredProposalReview request={{ ...request }} />);
      await tick();
      expect(complete).toHaveBeenCalledOnce();
      view.unmount();
    });

    it('accepts and rejects the current change', async () => {
      const accepted = createProposalReviewFixture();
      const acceptedComplete = vi.fn();
      const acceptedView = render(
        <WiredProposalReview
          request={{ id: 1, manager: accepted.manager, complete: acceptedComplete, interrupt: vi.fn() }}
        />,
      );
      acceptedView.stdin.write('y');
      await expect.poll(() => accepted.accept.mock.calls.length === 1).toBe(true);
      acceptedView.unmount();

      const rejected = createProposalReviewFixture();
      const rejectedView = render(
        <WiredProposalReview request={{ id: 2, manager: rejected.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      rejectedView.stdin.write('N');
      await expect.poll(() => rejected.reject.mock.calls.length === 1).toBe(true);
      rejectedView.unmount();

      expect(accepted.accept).toHaveBeenCalledWith('proposal', 'item');
      expect(rejected.reject).toHaveBeenCalledWith('proposal', 'item');
    });

    it('completes after acceptance removes the active review', async () => {
      const fixture = createProposalReviewFixture();
      const complete = vi.fn();
      fixture.accept.mockImplementationOnce(async () => {
        (fixture.manager.activeReviews as EditProposal[]).splice(0);
      });
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt: vi.fn() }} />,
      );

      view.stdin.write('y');
      await expect.poll(() => complete.mock.calls.length > 0).toBe(true);

      expect(complete).toHaveBeenCalledWith({ accepted: 1, rejected: 0 });
      view.unmount();
    });

    it('keeps the selection when a decision leaves pending work', async () => {
      const fixture = createProposalReviewFixture();
      fixture.accept.mockResolvedValueOnce();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      view.stdin.write('y');
      await expect.poll(() => fixture.accept.mock.calls.length === 1).toBe(true);
      await tick();

      expect(view.lastFrame()).toContain('File 1/1');
      view.unmount();
    });

    it('keeps the original progress denominator and advances the numerator', async () => {
      const fixture = createProposalReviewFixture();
      const first = fixture.proposal.files[0]!.items[0]!;
      const second = { ...first, id: 'item-2', sourceStart: 4, sourceEnd: 7 };
      fixture.proposal.files[0]!.items.push(second);
      fixture.accept.mockImplementation(async (_reviewId, itemId) => {
        fixture.proposal.files[0]!.items.find(item => item.id === itemId)!.decision = EditDecisionState.ACCEPTED;
      });
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      expect(view.lastFrame()).toContain('change 1/2');
      view.stdin.write('y');
      await expect.poll(() => (view.lastFrame() ?? '').includes('change 2/2')).toBe(true);

      expect(view.lastFrame()).not.toContain('change 1/1');
      const additionalProposal: EditProposal = {
        ...fixture.proposal,
        id: 'proposal-2',
        files: [
          {
            ...fixture.proposal.files[0]!,
            id: 'file-2',
            sourcePath: 'src/Other.tsx',
            targetPath: 'src/Other.tsx',
            items: [{ ...second, id: 'item-3', fileId: 'file-2', decision: EditDecisionState.PENDING }],
          },
        ],
      };
      (fixture.manager.activeReviews as EditProposal[]).push(additionalProposal);
      view.rerender(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      await expect.poll(() => (view.lastFrame() ?? '').includes('File 1/2  change 2/2')).toBe(true);
      view.stdin.write('\u001B[C');
      await expect.poll(() => (view.lastFrame() ?? '').includes('File 2/2  change 1/1')).toBe(true);
      view.unmount();
    });

    it('shows Error failures and non-Error failures', async () => {
      const errorFixture = createProposalReviewFixture();
      errorFixture.accept.mockRejectedValueOnce(new Error('stale\u001B[31m'));
      const errorView = render(
        <WiredProposalReview
          request={{ id: 1, manager: errorFixture.manager, complete: vi.fn(), interrupt: vi.fn() }}
        />,
      );
      errorView.stdin.write('y');
      await expect.poll(() => (errorView.lastFrame() ?? '').includes('Error: stale')).toBe(true);
      errorView.unmount();

      const valueFixture = createProposalReviewFixture();
      valueFixture.reject.mockRejectedValueOnce('failed');
      const valueView = render(
        <WiredProposalReview
          request={{ id: 2, manager: valueFixture.manager, complete: vi.fn(), interrupt: vi.fn() }}
        />,
      );
      valueView.stdin.write('n');
      await expect.poll(() => (valueView.lastFrame() ?? '').includes('Error: failed')).toBe(true);
      valueView.unmount();
    });

    it('supports interrupting and deferring a review', async () => {
      const interrupted = createProposalReviewFixture();
      const interrupt = vi.fn();
      const interruptedComplete = vi.fn();
      const interruptedView = render(
        <WiredProposalReview
          request={{ id: 1, manager: interrupted.manager, complete: interruptedComplete, interrupt }}
        />,
      );
      interruptedView.stdin.write('\u0003');
      await expect.poll(() => interrupt.mock.calls.length === 1).toBe(true);
      interruptedView.unmount();

      for (const key of ['\u001B', 'q']) {
        const deferred = createProposalReviewFixture();
        const complete = vi.fn();
        const view = render(
          <WiredProposalReview request={{ id: 2, manager: deferred.manager, complete, interrupt: vi.fn() }} />,
        );
        await tick();
        view.stdin.write(key);
        if (key === '\u001B')
          await new Promise<void>(resolve => {
            setTimeout(resolve, 75);
          });
        await expect.poll(() => complete.mock.calls.length === 1).toBe(true);
        view.unmount();
      }

      expect(interruptedComplete).toHaveBeenCalledOnce();
    });

    it('handles every navigation key and toggles the full-file view', async () => {
      const fixture = createProposalReviewFixture();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      for (const key of [
        '\u001B[B',
        '\u001B[A',
        '\u001B[6~',
        '\u001B[5~',
        '\u001B[H',
        '\u001B[F',
        '\u001B[C',
        '\u001B[D',
      ]) {
        view.stdin.write(key);
        await tick();
      }
      view.stdin.write('f');
      await expect.poll(() => (view.lastFrame() ?? '').includes('full file')).toBe(true);
      view.stdin.write('F');
      await expect.poll(() => (view.lastFrame() ?? '').includes('focused diff')).toBe(true);
      view.stdin.write('x');
      await tick();

      expect(view.lastFrame()).toContain('File 1/1');
      view.unmount();
    });

    it('ignores a decision when there is no current entry', async () => {
      const fixture = createProposalReviewFixture();
      fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.REJECTED;
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      view.stdin.write('y');
      await tick();

      expect(fixture.accept).not.toHaveBeenCalled();
      view.unmount();
    });

    it('ignores input while a decision is pending', async () => {
      const fixture = createProposalReviewFixture();
      let finish!: () => void;
      fixture.accept.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      view.stdin.write('y');
      await expect.poll(() => (view.lastFrame() ?? '').includes('saving…')).toBe(true);
      view.stdin.write('n');
      await tick();
      finish();
      await tick();

      expect(fixture.reject).not.toHaveBeenCalled();
      view.unmount();
    });
  });
});

async function tick(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

it('keeps an already-applied hunk through the existing review controls', async () => {
  const fixture = createProposalReviewFixture();
  const file = fixture.proposal.files[0]!;
  const item = file.items[0]!;
  item.decision = EditDecisionState.ACCEPTED;
  item.appliedText = { state: 'applied', before: file.base, after: file.proposed, revertTarget: null };
  fixture.accept.mockImplementation(async () => {
    item.appliedText!.state = 'kept';
  });
  const complete = vi.fn();
  const view = render(
    <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt: vi.fn() }} />,
  );
  try {
    expect(view.lastFrame()).toContain('Y keep  N revert');
    expect(complete).not.toHaveBeenCalled();
    view.stdin.write('y');
    await expect.poll(() => complete.mock.calls.length > 0).toBe(true);
    expect(fixture.accept).toHaveBeenCalledExactlyOnceWith(fixture.proposal.id, item.id);
    expect(complete).toHaveBeenCalledExactlyOnceWith({ accepted: 1, rejected: 0 });
  } finally {
    view.unmount();
  }
});
