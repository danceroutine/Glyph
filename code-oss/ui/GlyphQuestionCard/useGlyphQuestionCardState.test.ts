import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { GlyphQuestionRequest } from '#src/desktop/protocol/events/GlyphQuestionRequest.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { useGlyphQuestionCardState } from '#code-oss/ui/GlyphQuestionCard/useGlyphQuestionCardState.ts';

const questionRequest = (overrides: Partial<GlyphQuestionRequest> = {}): GlyphQuestionRequest => ({
  id: 'request',
  title: 'Setup',
  prompt: 'Pick options',
  questions: [
    {
      id: 'color',
      prompt: 'Color?',
      allowMultiple: false,
      options: [
        { id: 'red', label: 'Red' },
        { id: 'blue', label: 'Blue' },
      ],
    },
    {
      id: 'tools',
      prompt: 'Tools?',
      allowMultiple: true,
      options: [
        { id: 'git', label: 'Git' },
        { id: 'npm', label: 'npm' },
      ],
    },
  ],
  ...overrides,
});

const questionActions = () => ({
  answerQuestion: vi.fn(async (_chatId: string, _runId: string, _questionId: string, _answer: unknown) => {}),
  cancel: vi.fn(),
});

describe(useGlyphQuestionCardState, () => {
  it('starts at the first question without answers', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    expect(result.current.title).toBe('Setup');
    expect(result.current.questionNumber).toBe(1);
    expect(result.current.questionCount).toBe(2);
    expect(result.current.valid).toBe(false);
    expect(result.current.pending).toBe(false);
    expect(result.current.disabled).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(
      result.current.questions.map(({ question, inputName, other, selectedOptionIds, otherText }) => ({
        id: question.id,
        inputName,
        other,
        selectedOptionIds,
        otherText,
      })),
    ).toEqual([
      { id: 'color', inputName: 'request:color', other: false, selectedOptionIds: [], otherText: '' },
      { id: 'tools', inputName: 'request:tools', other: false, selectedOptionIds: [], otherText: '' },
    ]);
  });

  it('pluralizes the generic question title', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest({ title: 'Question' }),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    expect(result.current.title).toBe('Questions');
  });

  it.each([
    ['without questions', { id: 'request', title: 'Setup', prompt: 'Pick options' }],
    ['with an empty question list', questionRequest({ questions: [] })],
  ])('asks the request prompt as a free-form question when it comes %s', (_, request) => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request,
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    expect(result.current.questionCount).toBe(1);
    expect(result.current.questions[0]?.question).toEqual({
      id: 'request',
      prompt: 'Pick options',
      allowMultiple: false,
      options: [],
    });
    expect(result.current.questions[0]?.other).toBe(true);
  });

  it('restores draft answers', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [
          { questionId: 'color', type: QuestionAnswerType.OTHER, text: 'Green' },
          { questionId: 'tools', type: QuestionAnswerType.SELECTION, optionIds: ['git'] },
        ],
        onDraftChange: vi.fn(),
      },
    });

    expect(result.current.valid).toBe(true);
    expect(result.current.questions[0]).toMatchObject({ other: true, otherText: 'Green', selectedOptionIds: [] });
    expect(result.current.questions[1]).toMatchObject({ other: false, otherText: '', selectedOptionIds: ['git'] });
  });

  it('replaces a single choice and reports the draft', () => {
    const onDraftChange = vi.fn();
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange,
      },
    });

    act(() => result.current.questions[0]!.selectOption('red', true));
    act(() => result.current.questions[0]!.selectOption('blue', true));

    expect(result.current.questions[0]?.selectedOptionIds).toEqual(['blue']);
    expect(result.current.valid).toBe(true);
    expect(onDraftChange).toHaveBeenLastCalledWith([
      { questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['blue'] },
    ]);
  });

  it('adds and removes multiple choices', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.questions[1]!.selectOption('git', true));
    act(() => result.current.questions[1]!.selectOption('npm', true));
    act(() => result.current.questions[1]!.selectOption('npm', true));
    expect(result.current.questions[1]?.selectedOptionIds).toEqual(['git', 'npm']);

    act(() => result.current.questions[1]!.selectOption('git', false));
    expect(result.current.questions[1]?.selectedOptionIds).toEqual(['npm']);
  });

  it('removes a multiple choice that was never selected without effect', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [{ questionId: 'tools', type: QuestionAnswerType.OTHER, text: 'Make' }],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.questions[1]!.selectOption('git', false));

    expect(result.current.questions[1]?.selectedOptionIds).toEqual([]);
  });

  it('accepts a written answer once it has text', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.questions[0]!.enterOther());
    expect(result.current.questions[0]?.other).toBe(true);
    expect(result.current.valid).toBe(false);

    act(() => result.current.questions[0]!.updateOther('  '));
    expect(result.current.valid).toBe(false);

    act(() => result.current.questions[0]!.updateOther('Green'));
    expect(result.current.questions[0]?.otherText).toBe('Green');
    expect(result.current.valid).toBe(true);
  });

  it('moves between questions within bounds', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.back());
    expect(result.current.questionNumber).toBe(1);

    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.questionNumber).toBe(2);

    act(() => result.current.questions[0]!.activate());
    expect(result.current.questionNumber).toBe(1);
  });

  it('continues to the next question only once the current one is answered', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.continueForm());
    expect(result.current.questionNumber).toBe(1);

    act(() => result.current.questions[0]!.selectOption('red', true));
    act(() => result.current.continueForm());
    expect(result.current.questionNumber).toBe(2);
  });

  it('returns to the first unanswered question before submitting', () => {
    const actions = questionActions();
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions,
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.next());
    act(() => result.current.questions[1]!.selectOption('git', true));
    act(() => result.current.continueForm());

    expect(result.current.questionNumber).toBe(1);
    expect(actions.answerQuestion).not.toHaveBeenCalled();
  });

  it('submits every answer in question order and stays pending', async () => {
    const actions = questionActions();
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions,
        disabled: false,
        initialAnswers: [
          { questionId: 'tools', type: QuestionAnswerType.SELECTION, optionIds: ['git'] },
          { questionId: 'color', type: QuestionAnswerType.OTHER, text: 'Green' },
        ],
        onDraftChange: vi.fn(),
      },
    });
    act(() => result.current.next());

    await act(async () => result.current.continueForm());

    expect(actions.answerQuestion).toHaveBeenCalledWith('chat', 'run', 'request', {
      answers: [
        { questionId: 'color', type: QuestionAnswerType.OTHER, text: 'Green' },
        { questionId: 'tools', type: QuestionAnswerType.SELECTION, optionIds: ['git'] },
      ],
    });
    expect(result.current.pending).toBe(true);

    act(() => result.current.questions[1]!.selectOption('npm', true));
    act(() => result.current.back());
    await act(async () => result.current.continueForm());

    expect(result.current.questions[1]?.selectedOptionIds).toEqual(['git']);
    expect(result.current.questionNumber).toBe(2);
    expect(actions.answerQuestion).toHaveBeenCalledOnce();
  });

  it('ignores edits, navigation and submission from a window that does not own the chat', () => {
    const actions = questionActions();
    const onDraftChange = vi.fn();
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions,
        disabled: true,
        initialAnswers: [{ questionId: 'color', type: QuestionAnswerType.SELECTION, optionIds: ['red'] }],
        onDraftChange,
      },
    });

    act(() => result.current.questions[0]!.selectOption('blue', true));
    act(() => result.current.next());
    act(() => result.current.continueForm());

    expect(result.current.disabled).toBe(true);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(result.current.questionNumber).toBe(1);
    expect(actions.answerQuestion).not.toHaveBeenCalled();
  });

  it('cancels the turn through the host', () => {
    const actions = questionActions();
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions,
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.cancel());

    expect(actions.cancel).toHaveBeenCalledOnce();
  });

  it('ignores scrolling before it is shown', () => {
    const { result } = renderHook(useGlyphQuestionCardState, {
      initialProps: {
        request: questionRequest(),
        chatId: 'chat',
        runId: 'run',
        actions: questionActions(),
        disabled: false,
        initialAnswers: [],
        onDraftChange: vi.fn(),
      },
    });

    act(() => result.current.trackScroll());

    expect(result.current.questionNumber).toBe(1);
  });
});
