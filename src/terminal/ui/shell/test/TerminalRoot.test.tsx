import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ChatResponsePartType } from '../../../../chat/ChatResponsePartType.ts';
import { TerminalRoot } from '../TerminalRoot.presentational.tsx';
import { WiredTerminalRoot } from '../TerminalRoot.wired.tsx';
import { createProposalReviewFixture } from '../../proposal/test/ProposalReviewFixture.ts';

describe(TerminalRoot, () => {
  describe('rendering', () => {
    it('lays out transcript, response, and interaction content', () => {
      const view = render(
        <TerminalRoot
          entries={[{ id: 1, content: <Text>history</Text> }]}
          height={5}
          response={<Text>response</Text>}
          interaction={<Text>prompt</Text>}
        />,
      );

      expect(view.lastFrame()).toBe('history\nresponse\n\n\nprompt');
      view.unmount();
    });

    it('keeps the newest transcript content visible when it exceeds the viewport', async () => {
      const view = render(
        <TerminalRoot
          entries={[
            { id: 1, content: <Text>oldest</Text> },
            { id: 2, content: <Text>{'middle one\nmiddle two'}</Text> },
            { id: 3, content: <Text>newest</Text> },
          ]}
          height={4}
          response={<Text>response</Text>}
          interaction={<Text>prompt</Text>}
        />,
      );

      await new Promise<void>(resolve => setImmediate(resolve));
      expect(view.lastFrame()).toBe('middle two\nnewest\nresponse\nprompt');
      view.unmount();
    });
  });
});

describe(WiredTerminalRoot, () => {
  describe('rendering', () => {
    it('renders an active response without an interaction', () => {
      const view = render(
        <WiredTerminalRoot
          snapshot={{
            entries: [],
            responseParts: [{ type: ChatResponsePartType.TEXT, value: 'answer' }],
            prompt: undefined,
            review: undefined,
            interrupt: () => {},
          }}
        />,
      );

      expect(view.lastFrame()).toContain('answer');
      view.unmount();
    });

    it('prioritizes an active review over a prompt', () => {
      const fixture = createProposalReviewFixture();
      const view = render(
        <WiredTerminalRoot
          snapshot={{
            entries: [],
            responseParts: undefined,
            prompt: { id: 1, label: 'you> ', complete: () => {} },
            review: { id: 2, manager: fixture.manager, complete: () => {}, interrupt: () => {} },
            interrupt: () => {},
          }}
        />,
      );

      expect(view.lastFrame()).toContain('File 1/1');
      expect(view.lastFrame()).not.toContain('you>');
      view.unmount();
    });
  });
});
