import { useRef, useState } from 'react';
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

/** Owns keyboard interaction and answer progression for a terminal question form. */
export function useQuestionFormState({ request, active = true }: UseQuestionFormStateOptions): QuestionFormState {
  const { rows, columns } = useWindowSize();
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [highlightedOption, setHighlightedOption] = useState(0);
  const [selectedOptionIds, setSelectedOptionIds] = useState<readonly string[]>([]);
  const [enteringOther, setEnteringOther] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [otherCursor, setOtherCursor] = useState(0);
  const [diagnostic, setDiagnostic] = useState('');
  // Open at the question's beginning. Navigation opts back into following the
  // selected option; paging can then inspect any part of the question again.
  const [scrollOffset, setScrollOffset] = useState<number | undefined>(0);
  const answers = useRef<QuestionAnswer[]>([]);
  const question = request.form.questions[questionIndex]!;
  const otherOption = question.options.length;

  const resetForNextQuestion = (): void => {
    setHighlightedOption(0);
    setSelectedOptionIds([]);
    setEnteringOther(false);
    setOtherText('');
    setOtherCursor(0);
    setDiagnostic('');
    setScrollOffset(0);
  };

  const answer = (value: QuestionAnswer): void => {
    const completed = [...answers.current, value];
    answers.current = completed;
    if (questionIndex === request.form.questions.length - 1) {
      request.complete({ answers: completed });
      return;
    }
    resetForNextQuestion();
    setQuestionIndex(index => index + 1);
  };

  const submitOther = (): void => {
    const text = otherText.trim();
    if (!text) {
      setDiagnostic('Type an answer before continuing.');
      return;
    }
    answer({ questionId: question.id, type: QuestionAnswerType.OTHER, text });
  };

  const submitSelection = (): void => {
    if (highlightedOption === otherOption) {
      setEnteringOther(true);
      setDiagnostic('');
      return;
    }
    const highlightedId = question.options[highlightedOption]!.id;
    const optionIds = question.allowMultiple ? selectedOptionIds : [highlightedId];
    if (optionIds.length === 0) {
      setDiagnostic('Select at least one option before continuing.');
      return;
    }
    answer({ questionId: question.id, type: QuestionAnswerType.SELECTION, optionIds });
  };

  const updateOtherText = (text: string, cursor: number): void => {
    setScrollOffset(undefined);
    setOtherText(text);
    setOtherCursor(cursor);
    setDiagnostic('');
  };

  usePaste(
    value => {
      if (!enteringOther) return;
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
      if (key.ctrl && input.toLowerCase() === 'c') {
        request.interrupt();
        return;
      }
      const viewport = getQuestionViewport({ ...state, rows, columns });
      if (key.pageUp || key.pageDown) {
        const delta = Math.max(1, viewport.height - 1) * (key.pageDown ? 1 : -1);
        setScrollOffset(Math.max(0, Math.min(viewport.maximumOffset, viewport.offset + delta)));
        return;
      }
      // Never confirm a choice while paging has hidden it. The first Enter
      // returns to the selection, and a subsequent Enter confirms it.
      if (key.return && !viewport.focusVisible) {
        setScrollOffset(undefined);
        return;
      }
      if (enteringOther) {
        setScrollOffset(undefined);
        if (key.escape) {
          setEnteringOther(false);
          setDiagnostic('');
        } else if (key.return) submitOther();
        else if (key.leftArrow) setOtherCursor(previousCharacterOffset(otherText, otherCursor));
        else if (key.rightArrow) setOtherCursor(nextCharacterOffset(otherText, otherCursor));
        else if (key.home || (key.ctrl && input.toLowerCase() === 'a')) setOtherCursor(0);
        else if (key.end || (key.ctrl && input.toLowerCase() === 'e')) setOtherCursor(otherText.length);
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
        setScrollOffset(undefined);
        setHighlightedOption(index => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setScrollOffset(undefined);
        setHighlightedOption(index => Math.min(otherOption, index + 1));
        return;
      }
      if (input === ' ' && question.allowMultiple && highlightedOption < otherOption) {
        setScrollOffset(undefined);
        const optionId = question.options[highlightedOption]!.id;
        setSelectedOptionIds(selected =>
          selected.includes(optionId) ? selected.filter(id => id !== optionId) : [...selected, optionId],
        );
        setDiagnostic('');
        return;
      }
      if ((input === ' ' && highlightedOption === otherOption) || key.return) submitSelection();
    },
    { isActive: active },
  );

  const state: QuestionFormState = {
    title: request.form.title,
    question,
    questionNumber: questionIndex + 1,
    questionCount: request.form.questions.length,
    highlightedOption,
    selectedOptionIds,
    enteringOther,
    otherText,
    otherCursor,
    diagnostic,
    ...(scrollOffset === undefined ? {} : { scrollOffset }),
  };
  return state;
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
