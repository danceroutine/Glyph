import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { EditProposal } from '../../../editing/proposals/EditProposal.ts';
import { EditDecisionState } from '../../../editing/reviews/EditDecisionState.ts';
import { WiredProposalReview } from '../ProposalReview.wired.tsx';
import { createProposalReviewFixture } from './ProposalReviewFixture.ts';

describe(WiredProposalReview, () => {
  describe('interaction', () => {
    it('completes an empty review', async () => {
      const complete = vi.fn();
      const fixture = createProposalReviewFixture();
      fixture.proposal.files[0]!.items[0]!.decision = EditDecisionState.REJECTED;
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete, interrupt: vi.fn() }} />,
      );

      await waitUntil(() => complete.mock.calls.length === 1);
      expect(view.lastFrame()).toBe('Review complete.');
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
      await waitUntil(() => accepted.accept.mock.calls.length === 1);
      acceptedView.unmount();

      const rejected = createProposalReviewFixture();
      const rejectedView = render(
        <WiredProposalReview request={{ id: 2, manager: rejected.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );
      rejectedView.stdin.write('N');
      await waitUntil(() => rejected.reject.mock.calls.length === 1);
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
      await waitUntil(() => complete.mock.calls.length > 0);

      expect(complete).toHaveBeenCalled();
      view.unmount();
    });

    it('keeps the selection when a decision leaves pending work', async () => {
      const fixture = createProposalReviewFixture();
      fixture.accept.mockResolvedValueOnce();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      view.stdin.write('y');
      await waitUntil(() => fixture.accept.mock.calls.length === 1);
      await tick();

      expect(view.lastFrame()).toContain('File 1/1');
      view.unmount();
    });

    it('shows Error failures and non-Error failures', async () => {
      const errorFixture = createProposalReviewFixture();
      errorFixture.accept.mockRejectedValueOnce(new Error('stale\u001b[31m'));
      const errorView = render(
        <WiredProposalReview
          request={{ id: 1, manager: errorFixture.manager, complete: vi.fn(), interrupt: vi.fn() }}
        />,
      );
      errorView.stdin.write('y');
      await waitUntil(() => (errorView.lastFrame() ?? '').includes('Error: stale'));
      errorView.unmount();

      const valueFixture = createProposalReviewFixture();
      valueFixture.reject.mockRejectedValueOnce('failed');
      const valueView = render(
        <WiredProposalReview
          request={{ id: 2, manager: valueFixture.manager, complete: vi.fn(), interrupt: vi.fn() }}
        />,
      );
      valueView.stdin.write('n');
      await waitUntil(() => (valueView.lastFrame() ?? '').includes('Error: failed'));
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
      interruptedView.stdin.write('\x03');
      await waitUntil(() => interrupt.mock.calls.length === 1);
      interruptedView.unmount();

      for (const key of ['\x1b', 'q']) {
        const deferred = createProposalReviewFixture();
        const complete = vi.fn();
        const view = render(
          <WiredProposalReview request={{ id: 2, manager: deferred.manager, complete, interrupt: vi.fn() }} />,
        );
        await tick();
        view.stdin.write(key);
        if (key === '\x1b') await new Promise<void>(resolve => setTimeout(resolve, 75));
        await waitUntil(() => complete.mock.calls.length === 1);
        view.unmount();
      }

      expect(interruptedComplete).toHaveBeenCalledOnce();
    });

    it('handles every navigation key and toggles the full-file view', async () => {
      const fixture = createProposalReviewFixture();
      const view = render(
        <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />,
      );

      for (const key of ['\x1b[B', '\x1b[A', '\x1b[6~', '\x1b[5~', '\x1b[H', '\x1b[F', '\x1b[C', '\x1b[D']) {
        view.stdin.write(key);
        await tick();
      }
      view.stdin.write('f');
      await waitUntil(() => (view.lastFrame() ?? '').includes('full file'));
      view.stdin.write('F');
      await waitUntil(() => (view.lastFrame() ?? '').includes('focused diff'));
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
      await waitUntil(() => (view.lastFrame() ?? '').includes('applying…'));
      view.stdin.write('n');
      await tick();
      finish();
      await tick();

      expect(fixture.reject).not.toHaveBeenCalled();
      view.unmount();
    });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Condition was not reached.');
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
