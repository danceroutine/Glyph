import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphQuestionRequest } from '#src/desktop/protocol/events/GlyphQuestionRequest.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { WiredGlyphQuestionCard } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionCard.wired.tsx';

afterEach(cleanup);

const threeQuestions = (): GlyphQuestionRequest => ({
  id: 'request',
  title: 'Question',
  prompt: 'Setup',
  questions: [
    { id: 'a', prompt: 'First?', allowMultiple: false, options: [{ id: 'yes', label: 'Yes' }] },
    { id: 'b', prompt: 'Second?', allowMultiple: false, options: [{ id: 'yes', label: 'Yes' }] },
    { id: 'c', prompt: 'Third?', allowMultiple: false, options: [] },
  ],
});

describe(WiredGlyphQuestionCard, () => {
  it('answers each question in turn and submits them through the host', async () => {
    const answerQuestion = vi.fn(async () => {});
    const onDraftChange = vi.fn();
    render(
      <WiredGlyphQuestionCard
        request={threeQuestions()}
        chatId="chat"
        runId="run"
        actions={{ answerQuestion, cancel: vi.fn() }}
        disabled={false}
        initialAnswers={[]}
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getAllByRole('radio', { name: /Yes/u })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('radio', { name: /Yes/u })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(answerQuestion).toHaveBeenCalledWith('chat', 'run', 'request', {
        answers: [
          { questionId: 'a', type: QuestionAnswerType.SELECTION, optionIds: ['yes'] },
          { questionId: 'b', type: QuestionAnswerType.SELECTION, optionIds: ['yes'] },
          { questionId: 'c', type: QuestionAnswerType.OTHER, text: 'Because' },
        ],
      });
    });
    expect(onDraftChange).toHaveBeenCalledTimes(3);
  });

  it('scrolls the chosen question into view and focuses its first field', () => {
    render(
      <WiredGlyphQuestionCard
        request={threeQuestions()}
        chatId="chat"
        runId="run"
        actions={{ answerQuestion: vi.fn(async () => {}), cancel: vi.fn() }}
        disabled={false}
        initialAnswers={[]}
        onDraftChange={vi.fn()}
      />,
    );
    const viewport = document.querySelector<HTMLDivElement>('.glyph-question-scroll')!;
    const scrollTo = vi.spyOn(viewport, 'scrollTo').mockImplementation(() => {});
    const third = screen.getByRole('group', { name: '3. Third?' });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 300));
    vi.spyOn(third, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 400, 300, 100));

    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));

    expect(screen.getByRole('button', { name: 'Previous question' }).parentElement?.textContent).toContain('3 of 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300 });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your answer' }));
  });

  it('follows the question scrolled to the top of the card', () => {
    render(
      <WiredGlyphQuestionCard
        request={threeQuestions()}
        chatId="chat"
        runId="run"
        actions={{ answerQuestion: vi.fn(async () => {}), cancel: vi.fn() }}
        disabled={false}
        initialAnswers={[]}
        onDraftChange={vi.fn()}
      />,
    );
    const viewport = document.querySelector<HTMLDivElement>('.glyph-question-scroll')!;
    const groups = screen.getAllByRole('group');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 300));
    vi.spyOn(groups[0]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 110));
    vi.spyOn(groups[1]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 110, 300, 100));

    fireEvent.scroll(viewport);

    expect(screen.getByRole('button', { name: 'Previous question' }).parentElement?.textContent).toContain('2 of 3');
  });

  it('keeps its position when no question reaches below the top of the card', () => {
    const { rerender } = render(
      <WiredGlyphQuestionCard
        request={threeQuestions()}
        chatId="chat"
        runId="run"
        actions={{ answerQuestion: vi.fn(async () => {}), cancel: vi.fn() }}
        disabled={false}
        initialAnswers={[]}
        onDraftChange={vi.fn()}
      />,
    );
    const request = threeQuestions();
    rerender(
      <WiredGlyphQuestionCard
        request={{ ...request, questions: request.questions!.slice(0, 2) }}
        chatId="chat"
        runId="run"
        actions={{ answerQuestion: vi.fn(async () => {}), cancel: vi.fn() }}
        disabled={false}
        initialAnswers={[]}
        onDraftChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
    const viewport = document.querySelector<HTMLDivElement>('.glyph-question-scroll')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 300));
    for (const group of screen.getAllByRole('group'))
      vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 50));

    fireEvent.scroll(viewport);

    expect(screen.getByRole('button', { name: 'Previous question' }).parentElement?.textContent).toContain('2 of 2');
  });
});
