import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { TerminalRoot } from '#src/terminal/ui/shell/TerminalRoot.presentational.js';
import { WiredTerminalRoot } from '#src/terminal/ui/shell/TerminalRoot.wired.js';
import { createProposalReviewFixture } from '#src/terminal/ui/proposal/test/ProposalReviewFixture.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';

describe(TerminalRoot, () => {
  describe('rendering', () => {
    it('[round8-10] opens a different conversation at its newest message instead of retaining the previous scroll offset', async () => {
      const rows = (id: number, text: string) => (
        <TerminalRoot
          pagingActive
          height={4}
          entries={[{ id, content: <Text>{text}</Text> }]}
          response={undefined}
          interaction={<Text>prompt</Text>}
        />
      );
      const view = render(rows(1, 'oldest\nsecond\nthird\nfourth\nlatest'));
      try {
        await vi.waitFor(() => expect(view.lastFrame()).toContain('latest'));
        view.stdin.write('\u001b[5~');
        await vi.waitFor(() => expect(view.lastFrame()).toContain('oldest'));
        view.rerender(rows(2, 'other oldest\nsecond\nthird\nfourth\nother latest'));
        await vi.waitFor(() => expect(view.lastFrame()).toContain('other latest'));
      } finally {
        view.unmount();
      }
    });
    it('[round7-11] lets Page Up reveal older transcript rows and Page Down return to the latest response', async () => {
      const view = render(
        <TerminalRoot
          entries={[{ id: 1, content: <Text>{'oldest\nsecond\nthird\nfourth\nlatest'}</Text> }]}
          height={4}
          pagingActive
          response={undefined}
          interaction={<Text>prompt</Text>}
        />,
      );
      try {
        await vi.waitFor(() => expect(view.lastFrame()).toContain('latest'));
        view.stdin.write('\u001b[5~');
        await vi.waitFor(() => expect(view.lastFrame()).toContain('oldest'), { timeout: 500 });
        expect(view.lastFrame()).toContain('prompt');
        view.stdin.write('\u001b[6~');
        await vi.waitFor(() => expect(view.lastFrame()).toContain('latest'));
      } finally {
        view.unmount();
      }
    });

    it('lays out transcript, response, and interaction content', () => {
      const view = render(
        <TerminalRoot
          entries={[{ id: 1, content: <Text>history</Text> }]}
          height={5}
          response={<Text>response</Text>}
          backgroundShells={<Text>shells</Text>}
          interaction={<Text>prompt</Text>}
        />,
      );

      expect(view.lastFrame()).toBe('history\nresponse\n\nshells\nprompt');
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
            backgroundShells: [],
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
            backgroundShells: [],
            responseParts: undefined,
            prompt: { id: 1, label: 'you> ', acceptsSubmission: true, complete: () => {} },
            review: { id: 2, manager: fixture.manager, complete: () => {}, interrupt: () => {} },
            interrupt: () => {},
          }}
        />,
      );

      expect(view.lastFrame()).toContain('File 1/1');
      expect(view.lastFrame()).not.toContain('you>');
      view.unmount();
    });

    it('shows an active question while keeping the prompt hidden', () => {
      const view = render(
        <WiredTerminalRoot
          snapshot={{
            entries: [],
            backgroundShells: [],
            responseParts: undefined,
            prompt: { id: 1, label: 'you> ', acceptsSubmission: false },
            question: {
              id: 2,
              form: {
                questions: [
                  {
                    id: 'choice',
                    prompt: 'Choose one.',
                    options: [
                      { id: 'one', label: 'One' },
                      { id: 'two', label: 'Two' },
                    ],
                    allowMultiple: false,
                  },
                ],
              },
              complete: () => {},
              interrupt: () => {},
            },
            review: undefined,
            interrupt: () => {},
          }}
        />,
      );

      expect(view.lastFrame()).toContain('Choose one.');
      expect(view.lastFrame()).not.toContain('you>');
      view.unmount();
    });

    it('shows shell approval instead of the draft prompt and renders background terminals', () => {
      const view = render(
        <WiredTerminalRoot
          snapshot={{
            entries: [],
            responseParts: undefined,
            prompt: { id: 1, label: 'you> ', acceptsSubmission: false },
            shellPermission: {
              id: 2,
              permission: { command: 'pnpm test', workingDirectory: '/project' },
              complete: () => {},
              interrupt: () => {},
            },
            backgroundShells: [
              {
                id: 'terminal-one',
                workingDirectory: '/project',
                command: 'pnpm dev',
                status: ShellSessionStatus.RUNNING,
                background: true,
                outputTail: '',
                startedAt: '2026-10-07T00:00:00.000Z',
              },
            ],
            review: undefined,
            interrupt: () => {},
          }}
        />,
      );

      expect(view.lastFrame()).toContain('Shell permission required');
      expect(view.lastFrame()).toContain('› 1. Allow once');
      expect(view.lastFrame()).toContain('Esc deny');
      expect(view.lastFrame()).not.toContain('Background terminals (1)');
      expect(view.lastFrame()).not.toContain('you>');
      view.unmount();
    });
  });
});
