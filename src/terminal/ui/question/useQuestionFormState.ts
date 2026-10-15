import { useLayoutEffect, useRef, useState } from 'react';
import { useCursor, useInput, usePaste, useWindowSize } from 'ink';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import type { Question } from '#src/interaction/questions/Question.js';
import type { QuestionFormRequest } from './QuestionFormRequest.ts';
import { getQuestionViewport } from './getQuestionViewport.ts';

export interface QuestionFormState {
  readonly title: string | undefined;
  readonly question: Question;
  readonly questionNumber: number;
  readonly questionCount: number;
  readonly highlightedOption: number;
  readonly selectedOptionIds: readonly string[];
  readonly enteringOther: boolean;
  readonly otherText: string;
  readonly otherCursor: number;
  readonly diagnostic: string;
  readonly scrollOffset?: number;
}

export interface UseQuestionFormStateOptions {
  readonly request: QuestionFormRequest;
  readonly active?: boolean;
}

type QuestionInteraction = Omit<
  QuestionFormState,
  'title' | 'question' | 'questionNumber' | 'questionCount' | 'scrollOffset'
> & {
  readonly scrollOffset: number | undefined;
};

/** Owns keyboard interaction and answer progression for a terminal question form. */
export function useQuestionFormState({ request, active = true }: UseQuestionFormStateOptions): QuestionFormState {
  const { rows, columns } = useWindowSize();
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [interaction, setInteraction] = useState<QuestionInteraction>(initialInteraction);
  const current = useRef(interaction);
  const awaitingReveal = useRef(false);
  useLayoutEffect(() => {
    // A hidden choice must actually reach the screen before another Enter may
    // confirm it; synchronous input state alone is not evidence of visibility.
    awaitingReveal.current = false;
  }, [interaction]);
  const update = (changes: Partial<QuestionInteraction>): void => {
    // Ink can deliver navigation, typing, paste, and submission in one React
    // batch. Each input must observe the previous input's committed transition,
    // not the stale state captured when the last frame was rendered.
    current.current = { ...current.current, ...changes };
    setInteraction(current.current);
  };
  const answers = useRef<QuestionAnswer[]>([]);
  // Input arrives synchronously, while React commits the next question later.
  // Claim a question before scheduling that transition so repeated keys cannot
  // append its answer twice, skip a question, or settle the request twice.
  const answeredQuestion = useRef<number | undefined>(undefined);
  const settled = useRef(false);
  const question = request.form.questions[questionIndex]!;
  const otherOption = question.options.length;

  const readState = (value: QuestionInteraction): QuestionFormState => {
    const { scrollOffset, ...fields } = value;
    return {
      ...fields,
      title: request.form.title,
      question,
      questionNumber: questionIndex + 1,
      questionCount: request.form.questions.length,
      ...(scrollOffset === undefined ? {} : { scrollOffset }),
    };
  };

  const answer = (value: QuestionAnswer): void => {
    // The input handler checks settlement before dispatching either answer path.
    answeredQuestion.current = questionIndex;
    const completed = [...answers.current, value];
    answers.current = completed;
    if (questionIndex === request.form.questions.length - 1) {
      settled.current = true;
      request.complete({ answers: completed });
      return;
    }
    update(initialInteraction());
    setQuestionIndex(questionIndex + 1);
  };

  const submitOther = (): void => {
    const text = current.current.otherText.trim();
    if (!text) {
      update({ diagnostic: 'Type an answer before continuing.' });
      return;
    }
    answer({ questionId: question.id, type: QuestionAnswerType.OTHER, text });
  };

  const submitSelection = (): void => {
    const { highlightedOption, selectedOptionIds } = current.current;
    if (highlightedOption === otherOption) {
      update({ enteringOther: true, diagnostic: '' });
      return;
    }
    const highlightedId = question.options[highlightedOption]!.id;
    const optionIds = question.allowMultiple ? selectedOptionIds : [highlightedId];
    if (optionIds.length === 0) {
      update({ diagnostic: 'Select at least one option before continuing.' });
      return;
    }
    answer({ questionId: question.id, type: QuestionAnswerType.SELECTION, optionIds });
  };

  const updateOtherText = (text: string, cursor: number): void => {
    update({ scrollOffset: undefined, otherText: text, otherCursor: cursor, diagnostic: '' });
  };

  usePaste(
    value => {
      const { enteringOther, otherText, otherCursor } = current.current;
      if (!enteringOther || settled.current || answeredQuestion.current === questionIndex) return;
      const safe = value.replace(/[\r\n]+/gu, ' ');
      updateOtherText(
        `${otherText.slice(0, otherCursor)}${safe}${otherText.slice(otherCursor)}`,
        otherCursor + safe.length,
      );
    },
    { isActive: active },
  );

  useInput(
    (input, key) => {
      if (settled.current || key.eventType === 'release') return;
      if (key.ctrl && input.toLowerCase() === 'c') {
        settled.current = true;
        request.interrupt();
        return;
      }
      if (answeredQuestion.current === questionIndex) return;
      if (key.return && awaitingReveal.current) return;
      const { enteringOther, otherText, otherCursor, highlightedOption, selectedOptionIds } = current.current;
      const viewport = getQuestionViewport({ ...readState(current.current), rows, columns });
      if (key.pageUp || key.pageDown) {
        const delta = Math.max(1, viewport.height - 1) * (key.pageDown ? 1 : -1);
        update({ scrollOffset: Math.max(0, Math.min(viewport.maximumOffset, viewport.offset + delta)) });
        return;
      }
      // Never confirm a choice while paging has hidden it. The first Enter
      // returns to the selection, and a subsequent Enter confirms it.
      if (key.return) {
        const renderedViewport = getQuestionViewport({ ...readState(interaction), rows, columns });
        const visibleSelection = getQuestionViewport({
          ...readState(current.current),
          rows,
          columns,
          scrollOffset: renderedViewport.offset,
        }).focusVisible;
        if (!viewport.focusVisible || !visibleSelection) {
          awaitingReveal.current = true;
          update({ scrollOffset: undefined });
          return;
        }
      }
      if (enteringOther) {
        update({ scrollOffset: undefined });
        if (key.escape) {
          update({ enteringOther: false, diagnostic: '' });
        } else if (key.return) submitOther();
        else if (key.leftArrow) update({ otherCursor: previousCharacterOffset(otherText, otherCursor) });
        else if (key.rightArrow) update({ otherCursor: nextCharacterOffset(otherText, otherCursor) });
        else if (key.home || (key.ctrl && input.toLowerCase() === 'a')) update({ otherCursor: 0 });
        else if (key.end || (key.ctrl && input.toLowerCase() === 'e')) update({ otherCursor: otherText.length });
        else if (key.backspace) {
          const previous = previousCharacterOffset(otherText, otherCursor);
          if (previous !== otherCursor) {
            updateOtherText(otherText.slice(0, previous) + otherText.slice(otherCursor), previous);
          }
        } else if (key.delete) {
          const next = nextCharacterOffset(otherText, otherCursor);
          if (next !== otherCursor) {
            updateOtherText(otherText.slice(0, otherCursor) + otherText.slice(next), otherCursor);
          }
        } else if (isPrintableInput(input, key.ctrl, key.meta)) {
          updateOtherText(
            `${otherText.slice(0, otherCursor)}${input}${otherText.slice(otherCursor)}`,
            otherCursor + input.length,
          );
        }
        return;
      }
      if (key.upArrow) {
        update({ scrollOffset: undefined, highlightedOption: Math.max(0, highlightedOption - 1) });
        return;
      }
      if (key.downArrow) {
        update({ scrollOffset: undefined, highlightedOption: Math.min(otherOption, highlightedOption + 1) });
        return;
      }
      if (input === ' ' && question.allowMultiple && highlightedOption < otherOption) {
        const optionId = question.options[highlightedOption]!.id;
        update({
          scrollOffset: undefined,
          selectedOptionIds: selectedOptionIds.includes(optionId)
            ? selectedOptionIds.filter(id => id !== optionId)
            : [...selectedOptionIds, optionId],
          diagnostic: '',
        });
        return;
      }
      if ((input === ' ' && highlightedOption === otherOption) || key.return) submitSelection();
    },
    { isActive: active },
  );

  return readState(interaction);
}

function initialInteraction(): QuestionInteraction {
  return {
    highlightedOption: 0,
    selectedOptionIds: [],
    enteringOther: false,
    otherText: '',
    otherCursor: 0,
    diagnostic: '',
    // Open at the question's beginning; navigation opts into following selection.
    scrollOffset: 0,
  };
}

function isPrintableInput(input: string, control: boolean, meta: boolean): boolean {
  return input.length > 0 && !control && !meta && !/[\x00-\x1f\x7f]/u.test(input);
}

function previousCharacterOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  return previous >= 0xdc00 &&
    previous <= 0xdfff &&
    offset > 1 &&
    text.charCodeAt(offset - 2) >= 0xd800 &&
    text.charCodeAt(offset - 2) <= 0xdbff
    ? offset - 2
    : offset - 1;
}

function nextCharacterOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const current = text.charCodeAt(offset);
  return current >= 0xd800 &&
    current <= 0xdbff &&
    text.charCodeAt(offset + 1) >= 0xdc00 &&
    text.charCodeAt(offset + 1) <= 0xdfff
    ? offset + 2
    : offset + 1;
}
