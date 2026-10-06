import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ProposalReview } from '../ProposalReview.presentational.tsx';
import { ProposalReviewReceipt } from '../ProposalReviewReceipt.presentational.tsx';

describe(ProposalReview, () => {
  describe('rendering', () => {
    it('renders a completed review', () => {
      const view = render(
        <ProposalReview
          rows={10}
          header="Review complete — 2 accepted, 1 rejected"
          diagnostic=""
          visibleLines={[]}
          navigationHelp=""
          decisionHelp=""
          complete
        />,
      );

      expect(view.lastFrame()).toBe('Review complete — 2 accepted, 1 rejected');
      view.unmount();
    });

    it('renders the current review and its diagnostic', () => {
      const view = render(
        <ProposalReview
          rows={6}
          header="File 1/2"
          diagnostic="Error: stale"
          visibleLines={['- old', '+ new']}
          navigationHelp="arrows"
          decisionHelp="accept"
          complete={false}
        />,
      );

      expect(view.lastFrame()).toBe('File 1/2\nError: stale\n- old\n+ new\narrows\naccept');
      view.unmount();
    });

    it('omits an empty diagnostic', () => {
      const view = render(
        <ProposalReview
          rows={4}
          header="File 1/1"
          diagnostic=""
          visibleLines={['content']}
          navigationHelp="arrows"
          decisionHelp="accept"
          complete={false}
        />,
      );

      expect(view.lastFrame()).toBe('File 1/1\ncontent\narrows\naccept');
      view.unmount();
    });
  });
});

describe(ProposalReviewReceipt, () => {
  describe('rendering', () => {
    it.each([
      [2, 0, '✓ Review complete — 2 accepted, 0 rejected'],
      [1, 3, '✓ Review complete — 1 accepted, 3 rejected'],
    ])('renders %i accepted and %i rejected decisions', (accepted, rejected, expected) => {
      const view = render(<ProposalReviewReceipt accepted={accepted} rejected={rejected} />);

      expect(view.lastFrame()?.trimStart()).toBe(expected);
      view.unmount();
    });
  });
});
