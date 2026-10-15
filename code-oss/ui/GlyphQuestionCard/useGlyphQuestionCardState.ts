import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphQuestionRequest } from '#src/desktop/protocol/events/GlyphQuestionRequest.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { useGlyphDecision } from '#code-oss/ui/useGlyphDecision.ts';

export interface GlyphQuestionCardStateOptions {
  readonly request: GlyphQuestionRequest;
  readonly chatId: string;
  readonly runId: string;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'answerQuestion' | 'cancel'>;
  readonly disabled: boolean;
  readonly initialAnswers: readonly QuestionAnswer[];
  readonly onDraftChange: (answers: readonly QuestionAnswer[]) => void;
}

export type GlyphQuestionCardState = ReturnType<typeof useGlyphQuestionCardState>;

export function useGlyphQuestionCardState({
  request,
  chatId,
  runId,
  actions,
  disabled,
  initialAnswers,
  onDraftChange,
}: GlyphQuestionCardStateOptions) {
  const questions = request.questions?.length
    ? request.questions
    : [{ id: request.id, prompt: request.prompt, allowMultiple: false, options: [] }];
  const [answers, setAnswers] = useState(initialAnswers);
  const [step, setStep] = useState(0);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const { pending, error, submit } = useGlyphDecision();
  const question = questions[step]!;
  const answer = answers.find(value => value.questionId === question.id);
  const other = answer?.type === QuestionAnswerType.OTHER || question.options.length === 0;
  const valid =
    !!answer && (answer.type === QuestionAnswerType.OTHER ? !!answer.text.trim() : answer.optionIds.length > 0);
  const update = (value: QuestionAnswer) => {
    const next = [...answers.filter(answer => answer.questionId !== value.questionId), value];
    setAnswers(next);
    onDraftChange(next);
  };
  useLayoutEffect(() => {
    if (!disabled) fieldset.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus();
  }, [step]);
  const continueForm = () => {
    if (disabled || pending || !valid) return;
    if (step < questions.length - 1) setStep(step + 1);
    else
      void submit(() =>
        actions.answerQuestion(chatId, runId, request.id, {
          answers: questions.map(question => answers.find(value => value.questionId === question.id)!),
        }),
      );
  };
  return {
    title: request.title === 'Question' ? 'Questions' : request.title,
    question,
    questionNumber: step + 1,
    questionCount: questions.length,
    inputName: `${request.id}:${question.id}`,
    fieldset,
    other,
    selectedOptionIds: answer?.type === QuestionAnswerType.SELECTION ? answer.optionIds : [],
    otherText: answer?.type === QuestionAnswerType.OTHER ? answer.text : '',
    disabled,
    pending,
    error,
    valid,
    continueForm,
    selectOption: (optionId: string, checked: boolean) => {
      const selected = answer?.type === QuestionAnswerType.SELECTION ? answer.optionIds : [];
      update({
        questionId: question.id,
        type: QuestionAnswerType.SELECTION,
        optionIds: question.allowMultiple
          ? checked
            ? [...selected, optionId]
            : selected.filter(id => id !== optionId)
          : [optionId],
      });
    },
    enterOther: () => update({ questionId: question.id, type: QuestionAnswerType.OTHER, text: '' }),
    updateOther: (text: string) => update({ questionId: question.id, type: QuestionAnswerType.OTHER, text }),
    cancel: () => actions.cancel(),
    back: () => setStep(step - 1),
  };
}
