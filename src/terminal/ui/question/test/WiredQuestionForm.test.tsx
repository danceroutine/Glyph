import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { QuestionAnswerType } from '../../../../interaction/questions/QuestionAnswerType.ts';
import type { QuestionFormRequest } from '../QuestionFormRequest.ts';
import { WiredQuestionForm } from '../QuestionForm.wired.tsx';

describe(WiredQuestionForm, () => {
  describe('interaction', () => {
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
