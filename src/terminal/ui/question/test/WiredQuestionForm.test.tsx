import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import type { QuestionFormRequest } from '#src/terminal/ui/question/QuestionFormRequest.js';
import { WiredQuestionForm } from '#src/terminal/ui/question/QuestionForm.wired.js';

describe(WiredQuestionForm, () => {
  describe('interaction', () => {
    it.each([
      ['Down', '\u001B[1;1:3B'],
      ['Enter', '\u001B[13;1:3u'],
      ['Ctrl+C', '\u001B[99;5:3u'],
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
        await write(view, '\u001B[B');
        await write(view, '\u001B[B');
        await write(view, '\r');
        await write(view, 'answer');
        await write(view, '\u001B[127;1:3u');
        await write(view, '\u001B[120;1:3u');
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
          view.stdin.write(reveal === 'Enter' ? '\r' : '\u001B[B');
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
        view.stdin.write('\u001B[B');
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
        view.stdin.write('\u001B[B');
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
        view.stdin.write('\u001B[B');
        view.stdin.write('\u001B[B');
        view.stdin.write('\r');
        if (input === 'typed') {
          view.stdin.write('ab');
          view.stdin.write('cd');
          view.stdin.write('\u007F');
          view.stdin.write('!');
        } else {
          view.stdin.write('\u001B[200~abc!\u001B[201~');
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
        await expect.poll(() => (view.lastFrame() ?? '').includes('Question  2/2')).toBe(true);
        await write(view, '\r');
        expect(firstComplete).toHaveBeenCalledTimes(1);
        view.rerender(
          <WiredQuestionForm request={{ ...request(nextComplete, [question('replacement', false)]), id: 2 }} />,
        );
        await expect.poll(() => (view.lastFrame() ?? '').includes('Choose for replacement.')).toBe(true);
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
        await expect.poll(() => (view.lastFrame() ?? '').includes('Question  2/2')).toBe(true);
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
            await write(view, '\u001B[B');
            await write(view, '\u001B[B');
            await write(view, '\r');
            await write(view, 'custom');
          }
          view.stdin.write('\r');
          view.stdin.write('\r');
          view.stdin.write('\u0003');
          await tick();
          expect(complete).toHaveBeenCalledTimes(1);
          expect((complete.mock.calls[0]?.[0] as { answers: unknown[] } | undefined)?.answers).toHaveLength(1);
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
        view.stdin.write('\u0003');
        view.stdin.write('\u0003');
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

      await write(view, '\u001B[B');
      await write(view, '\r');
      await expect.poll(() => (view.lastFrame() ?? '').includes('Question  2/2')).toBe(true);
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, '\r');
      await expect.poll(() => (view.lastFrame() ?? '').includes('other>')).toBe(true);
      await write(view, '\r');
      await expect.poll(() => (view.lastFrame() ?? '').includes('Type an answer')).toBe(true);
      await write(view, 'Custom');
      await write(view, '\r');
      await expect.poll(() => complete.mock.calls.length === 1).toBe(true);

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
      await expect.poll(() => (view.lastFrame() ?? '').includes('Select at least one')).toBe(true);
      await write(view, ' ');
      await write(view, '\u001B[B');
      await write(view, ' ');
      await write(view, '\u001B[A');
      await write(view, ' ');
      await write(view, '\r');
      await expect.poll(() => complete.mock.calls.length === 1).toBe(true);

      expect(complete).toHaveBeenCalledWith({
        answers: [{ questionId: 'features', type: QuestionAnswerType.SELECTION, optionIds: ['second'] }],
      });
      view.unmount();
    });

    it('edits Other text with cursor keys, deletion, paste, and Escape', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('name', false)])} />);

      await write(view, 'x');
      await write(view, '\u001B[A');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, ' ');
      await expect.poll(() => (view.lastFrame() ?? '').includes('other>')).toBe(true);
      await write(view, 'a😀b');
      await write(view, '\u001B[H');
      await write(view, '\u001B[C');
      await write(view, '\u001B[C');
      await write(view, '\u0005');
      await write(view, '\u001B[D');
      await write(view, '\u007F');
      await write(view, '\u001B[C');
      await write(view, '\u001B[C');
      await write(view, '\u001B[3~');
      await write(view, '\u001B[H');
      await write(view, '\u007F');
      await write(view, '\u001B[3~');
      await write(view, '\u0005');
      await write(view, '\u0001');
      await write(view, '\u001B[C');
      await write(view, '\u0018');
      await write(view, '\u001B[200~ pasted\ntext\u001B[201~');
      await writeEscape(view);
      await expect.poll(() => !(view.lastFrame() ?? '').includes('other>')).toBe(true);
      await write(view, ' ');
      await expect.poll(() => (view.lastFrame() ?? '').includes('other>')).toBe(true);
      await write(view, 'final');
      await write(view, '\r');
      await expect.poll(() => complete.mock.calls.length === 1).toBe(true);

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
      inactive.stdin.write('\u001B[B');
      inactive.stdin.write('\u0003');
      await tick();

      expect(inactive.lastFrame()).toContain('› ● First');
      expect(interrupt).not.toHaveBeenCalled();
      inactive.unmount();

      const active = render(
        <WiredQuestionForm request={{ ...request(vi.fn(), [question('one', false)]), interrupt }} />,
      );
      active.stdin.write('\u0003');
      await expect.poll(() => interrupt.mock.calls.length === 1).toBe(true);
      active.unmount();
    });

    it('ignores paste outside the Other editor', async () => {
      const complete = vi.fn();
      const view = render(<WiredQuestionForm request={request(complete, [question('one', false)])} />);

      view.stdin.write('\u001B[200~ignored\u001B[201~');
      view.stdin.write('\r');
      await expect.poll(() => complete.mock.calls.length === 1).toBe(true);

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

async function tick(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

async function write(view: ReturnType<typeof render>, input: string): Promise<void> {
  view.stdin.write(input);
  await tick();
}

async function writeEscape(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write('\u001B');
  await new Promise<void>(resolve => {
    setTimeout(resolve, 75);
  });
}
