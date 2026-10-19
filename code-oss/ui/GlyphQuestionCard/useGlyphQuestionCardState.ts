import { useRef, useState } from 'preact/hooks';
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
  const viewport = useRef<HTMLDivElement>(null);
  const fieldsets = useRef<(HTMLFieldSetElement | null)[]>([]);
  const { pending, error, submit } = useGlyphDecision();
  const isValid = (questionId: string) => {
    const answer = answers.find(value => value.questionId === questionId);
    return !!answer && (answer.type === QuestionAnswerType.OTHER ? !!answer.text.trim() : answer.optionIds.length > 0);
  };
  const update = (value: QuestionAnswer) => {
    if (disabled || pending) return;
    const next = [...answers.filter(answer => answer.questionId !== value.questionId), value];
    setAnswers(next);
    onDraftChange(next);
  };
  const navigate = (index: number) => {
    if (disabled || pending) return;
    const next = Math.max(0, Math.min(questions.length - 1, index));
    setStep(next);
    const container = viewport.current;
    const fieldset = fieldsets.current[next];
    if (container && fieldset) {
      container.scrollTo({
        top: container.scrollTop + fieldset.getBoundingClientRect().top - container.getBoundingClientRect().top,
      });
      fieldset.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus({ preventScroll: true });
    }
  };
  const continueForm = () => {
    if (disabled || pending || !isValid(questions[step]!.id)) return;
    if (step < questions.length - 1) navigate(step + 1);
    else {
      const missing = questions.findIndex(question => !isValid(question.id));
      if (missing !== -1) navigate(missing);
      else
        void submit(() =>
          actions.answerQuestion(chatId, runId, request.id, {
            answers: questions.map(question => answers.find(value => value.questionId === question.id)!),
          }),
        );
    }
  };
  return {
    title: request.title === 'Question' ? 'Questions' : request.title,
    questionNumber: step + 1,
    questionCount: questions.length,
    viewport,
    trackScroll: () => {
      const container = viewport.current;
      if (!container) return;
      const top = container.getBoundingClientRect().top;
      const index = fieldsets.current.findIndex(
        fieldset => fieldset && fieldset.getBoundingClientRect().bottom > top + 24,
      );
      if (index !== -1) setStep(index);
    },
    questions: questions.map((question, index) => {
      const answer = answers.find(value => value.questionId === question.id);
      return {
        question,
        inputName: `${request.id}:${question.id}`,
        fieldset: (element: HTMLFieldSetElement | null) => {
          fieldsets.current[index] = element;
        },
        activate: () => setStep(index),
        other: answer?.type === QuestionAnswerType.OTHER || question.options.length === 0,
        selectedOptionIds: answer?.type === QuestionAnswerType.SELECTION ? answer.optionIds : [],
        otherText: answer?.type === QuestionAnswerType.OTHER ? answer.text : '',
        selectOption: (optionId: string, checked: boolean) => {
          const selected = answer?.type === QuestionAnswerType.SELECTION ? answer.optionIds : [];
          update({
            questionId: question.id,
            type: QuestionAnswerType.SELECTION,
            optionIds: question.allowMultiple
              ? checked
                ? [...new Set([...selected, optionId])]
                : selected.filter(id => id !== optionId)
              : [optionId],
          });
        },
        enterOther: () => update({ questionId: question.id, type: QuestionAnswerType.OTHER, text: '' }),
        updateOther: (text: string) => update({ questionId: question.id, type: QuestionAnswerType.OTHER, text }),
      };
    }),
    disabled,
    pending,
    error,
    valid: isValid(questions[step]!.id),
    continueForm,
    cancel: () => actions.cancel(),
    back: () => navigate(step - 1),
    next: () => navigate(step + 1),
  };
}
