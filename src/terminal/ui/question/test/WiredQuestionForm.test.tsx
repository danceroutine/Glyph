import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import type { QuestionFormRequest } from '#src/terminal/ui/question/QuestionFormRequest.js';
import { WiredQuestionForm } from '#src/terminal/ui/question/QuestionForm.wired.js';

describe(WiredQuestionForm, () => {
  describe('interaction', () => {
    it.each([
      ['Down', '\x1b[1;1:3B'],
      ['Enter', '\x1b[13;1:3u'],
      ['Ctrl+C', '\x1b[99;5:3u'],
    ])('ignores a %s release without navigating, submitting, or interrupting', async (_key, input) => {
      const complete = vi.fn();
      const interrupt = vi.fn();
      const view = render(
        <WiredQuestionForm request={{ ...request(complete, [question('choice', false)]), interrupt }} />,
      );
      try {
        await write(view, input);
        expect(complete).not.toHaveBeenCalled();
        expect(interrupt).not.toHaveBeenCalled();
        await write(view, '\r');
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['first'] }],
        });
      } finally {
        view.unmount();
      }
    });

    it('does not edit an Other answer on character and Backspace releases', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('choice', false)])} />);
      try {
        await write(view, '\x1b[B');
        await write(view, '\x1b[B');
        await write(view, '\r');
        await write(view, 'answer');
        await write(view, '\x1b[127;1:3u');
        await write(view, '\x1b[120;1:3u');
        await write(view, '\r');
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'choice', type: QuestionAnswerType.OTHER, text: 'answer' }],
        });
      } finally {
        view.unmount();
      }
    });

    it.each(['Enter', 'navigation'] as const)(
      'waits for the selection to render after %s reveals a long question',
      async reveal => {
        const complete = vi.fn();
        const view = render(
          <WiredQuestionForm
            request={request(complete, [{ ...question('long', false), prompt: 'Explain this detail.\n'.repeat(60) }])}
          />,
        );
        try {
          await tick();
          view.stdin.write(reveal === 'Enter' ? '\r' : '\x1b[B');
          view.stdin.write('\r');
          await tick();
          expect(complete).not.toHaveBeenCalled();
          await write(view, '\r');
          expect(complete).toHaveBeenCalledTimes(1);
        } finally {
          view.unmount();
        }
      },
    );

    it('submits the newly highlighted option when navigation and Enter arrive before a render', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('choice', false)])} />);
      try {
        await tick();
        view.stdin.write('\x1b[B');
        view.stdin.write('\r');
        await tick();
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['second'] }],
        });
      } finally {
        view.unmount();
      }
    });

    it('retains rapid multi-selection toggles and submits their latest values', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('choices', true)])} />);
      try {
        await tick();
        view.stdin.write(' ');
        view.stdin.write('\x1b[B');
        view.stdin.write(' ');
        view.stdin.write('\r');
        await tick();
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'choices', type: QuestionAnswerType.SELECTION, optionIds: ['first', 'second'] }],
        });
      } finally {
        view.unmount();
      }
    });

    it.each(['typed', 'pasted'] as const)('submits the latest %s Other text before a render', async input => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('name', false)])} />);
      try {
        await tick();
        view.stdin.write('\x1b[B');
        view.stdin.write('\x1b[B');
        view.stdin.write('\r');
        if (input === 'typed') {
          view.stdin.write('ab');
          view.stdin.write('cd');
          view.stdin.write('\x7f');
          view.stdin.write('!');
        } else {
          view.stdin.write('\x1b[200~abc!\x1b[201~');
        }
        view.stdin.write('\r');
        await tick();
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'name', type: QuestionAnswerType.OTHER, text: 'abc!' }],
        });
      } finally {
        view.unmount();
      }
    });

    it('starts a replacement request at its first question without retaining answers or settlement', async () => {
      const firstComplete = vi.fn();
      const nextComplete = vi.fn();
      const view = render(
        <WiredQuestionForm request={request(firstComplete, [question('first', false), question('second', false)])} />,
      );
      try {
        await write(view, '\r');
        await waitUntil(() => (view.lastFrame() ?? '').includes('Question  2/2'));
        await write(view, '\r');
        expect(firstComplete).toHaveBeenCalledTimes(1);
        view.rerender(
          <WiredQuestionForm request={{ ...request(nextComplete, [question('replacement', false)]), id: 2 }} />,
        );
        await waitUntil(() => (view.lastFrame() ?? '').includes('Choose for replacement.'));
        await write(view, '\r');
        expect(nextComplete).toHaveBeenCalledExactlyOnceWith({
          answers: [{ questionId: 'replacement', type: QuestionAnswerType.SELECTION, optionIds: ['first'] }],
        });
      } finally {
        view.unmount();
      }
    });

    it('answers each question only once when Enter repeats before the next render', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredQuestionForm request={request(complete, [question('first', false), question('second', false)])} />,
      );
      try {
        await tick();
        view.stdin.write('\r');
        view.stdin.write('\r');
        await waitUntil(() => (view.lastFrame() ?? '').includes('Question  2/2'));
        expect(complete).not.toHaveBeenCalled();
        view.stdin.write('\r');
        view.stdin.write('\r');
        await tick();
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          answers: [
            { questionId: 'first', type: QuestionAnswerType.SELECTION, optionIds: ['first'] },
            { questionId: 'second', type: QuestionAnswerType.SELECTION, optionIds: ['first'] },
          ],
        });
      } finally {
        view.unmount();
      }
    });

    it.each(['selection', 'other'] as const)(
      'settles a final %s answer once and ignores later interrupts',
      async kind => {
        const complete = vi.fn();
        const interrupt = vi.fn();
        const view = render(
          <WiredQuestionForm request={{ ...request(complete, [question('only', false)]), interrupt }} />,
        );
        try {
          await tick();
          if (kind === 'other') {
            await write(view, '\x1b[B');
            await write(view, '\x1b[B');
            await write(view, '\r');
            await write(view, 'custom');
          }
          view.stdin.write('\r');
          view.stdin.write('\r');
          view.stdin.write('\x03');
          await tick();
          expect(complete).toHaveBeenCalledTimes(1);
          expect(complete.mock.calls[0]?.[0].answers).toHaveLength(1);
          expect(interrupt).not.toHaveBeenCalled();
        } finally {
          view.unmount();
        }
      },
    );

    it('interrupts once and prevents an answer from being submitted after cancellation', async () => {
      const complete = vi.fn();
      const interrupt = vi.fn();
      const view = render(
        <WiredQuestionForm request={{ ...request(complete, [question('only', false)]), interrupt }} />,
      );
      try {
        await tick();
        view.stdin.write('\x03');
        view.stdin.write('\x03');
        view.stdin.write('\r');
        await tick();
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(complete).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it('answers consecutive single-choice and Other questions', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredQuestionForm request={request(complete, [question('first', false), question('second', false)])} />,
      );

      await write(view, '\x1b[B');
      await write(view, '\r');
      await waitUntil(() => (view.lastFrame() ?? '').includes('Question  2/2'));
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\r');
      await waitUntil(() => (view.lastFrame() ?? '').includes('other>'));
      await write(view, '\r');
      await waitUntil(() => (view.lastFrame() ?? '').includes('Type an answer'));
      await write(view, 'Custom');
      await write(view, '\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({
        answers: [
          { questionId: 'first', type: QuestionAnswerType.SELECTION, optionIds: ['second'] },
          { questionId: 'second', type: QuestionAnswerType.OTHER, text: 'Custom' },
        ],
      });
      view.unmount();
    });

    it('requires, toggles, and submits multiple selections', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('features', true)])} />);

      await write(view, '\r');
      await waitUntil(() => (view.lastFrame() ?? '').includes('Select at least one'));
      await write(view, ' ');
      await write(view, '\x1b[B');
      await write(view, ' ');
      await write(view, '\x1b[A');
      await write(view, ' ');
      await write(view, '\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({
        answers: [{ questionId: 'features', type: QuestionAnswerType.SELECTION, optionIds: ['second'] }],
      });
      view.unmount();
    });

    it('edits Other text with cursor keys, deletion, paste, and Escape', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('name', false)])} />);

      await write(view, 'x');
      await write(view, '\x1b[A');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, ' ');
      await waitUntil(() => (view.lastFrame() ?? '').includes('other>'));
      await write(view, 'a😀b');
      await write(view, '\x1b[H');
      await write(view, '\x1b[C');
      await write(view, '\x1b[C');
      await write(view, '\x05');
      await write(view, '\x1b[D');
      await write(view, '\x7f');
      await write(view, '\x1b[C');
      await write(view, '\x1b[C');
      await write(view, '\x1b[3~');
      await write(view, '\x1b[H');
      await write(view, '\x7f');
      await write(view, '\x1b[3~');
      await write(view, '\x05');
      await write(view, '\x01');
      await write(view, '\x1b[C');
      await write(view, '\x18');
      await write(view, '\x1b[200~ pasted\ntext\x1b[201~');
      await writeEscape(view);
      await waitUntil(() => !(view.lastFrame() ?? '').includes('other>'));
      await write(view, ' ');
      await waitUntil(() => (view.lastFrame() ?? '').includes('other>'));
      await write(view, 'final');
      await write(view, '\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete.mock.calls[0]?.[0]).toEqual({
        answers: [{ questionId: 'name', type: QuestionAnswerType.OTHER, text: expect.stringContaining('final') }],
      });
      view.unmount();
    });

    it('forwards Ctrl+C and ignores input while inactive', async () => {
      const interrupt = vi.fn();
      const inactive = render(
        <WiredQuestionForm request={{ ...request(vi.fn(), [question('one', false)]), interrupt }} active={false} />,
      );
      inactive.stdin.write('\x1b[B');
      inactive.stdin.write('\x03');
      await tick();

      expect(inactive.lastFrame()).toContain('› ● First');
      expect(interrupt).not.toHaveBeenCalled();
      inactive.unmount();

      const active = render(
        <WiredQuestionForm request={{ ...request(vi.fn(), [question('one', false)]), interrupt }} />,
      );
      active.stdin.write('\x03');
      await waitUntil(() => interrupt.mock.calls.length === 1);
      active.unmount();
    });

    it('ignores paste outside the Other editor', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('one', false)])} />);

      view.stdin.write('\x1b[200~ignored\x1b[201~');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete.mock.calls[0]?.[0]).toEqual({
        answers: [{ questionId: 'one', type: QuestionAnswerType.SELECTION, optionIds: ['first'] }],
      });
      view.unmount();
    });
  });
});

function request(
  complete: QuestionFormRequest['complete'],
  questions: QuestionFormRequest['form']['questions'],
): QuestionFormRequest {
  return { id: 1, form: { questions }, complete, interrupt: vi.fn() };
}

function question(id: string, allowMultiple: boolean) {
  return {
    id,
    prompt: `Choose for ${id}.`,
    options: [
      { id: 'first', label: 'First' },
      { id: 'second', label: 'Second' },
    ],
    allowMultiple,
  };
}

async function waitUntil(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (assertion()) return;
    await tick();
  }
  throw new Error('Timed out waiting for terminal render.');
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function write(view: ReturnType<typeof render>, input: string): Promise<void> {
  view.stdin.write(input);
  await tick();
}

async function writeEscape(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write('\x1b');
  await new Promise<void>(resolve => setTimeout(resolve, 75));
}
