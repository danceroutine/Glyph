import { useRef, useState } from 'react';
import { useCursor, useInput, usePaste } from 'ink';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.ts';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.ts';
import type { Question } from '#src/interaction/questions/Question.ts';
import type { QuestionFormRequest } from './QuestionFormRequest.ts';

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
}

export interface UseQuestionFormStateOptions {
  readonly request: QuestionFormRequest;
  readonly active?: boolean;
}

/** Owns keyboard interaction and answer progression for a terminal question form. */
export function useQuestionFormState({ request, active = true }: UseQuestionFormStateOptions): QuestionFormState {
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [highlightedOption, setHighlightedOption] = useState(0);
  const [selectedOptionIds, setSelectedOptionIds] = useState<readonly string[]>([]);
  const [enteringOther, setEnteringOther] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [otherCursor, setOtherCursor] = useState(0);
  const [diagnostic, setDiagnostic] = useState('');
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
      if (enteringOther) {
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
        setHighlightedOption(index => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setHighlightedOption(index => Math.min(otherOption, index + 1));
        return;
      }
      if (input === ' ' && question.allowMultiple && highlightedOption < otherOption) {
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

  return {
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
