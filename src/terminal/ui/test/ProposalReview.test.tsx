import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ProposalReview } from '../ProposalReview.presentational.tsx';

describe(ProposalReview, () => {
  describe('rendering', () => {
    it('renders a completed review', () => {
      const view = render(
        <ProposalReview
          rows={10}
          header="Review complete."
          diagnostic=""
          visibleLines={[]}
          navigationHelp=""
          decisionHelp=""
          complete
        />,
      );

      expect(view.lastFrame()).toBe('Review complete.');
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
