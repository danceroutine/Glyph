import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphQuestionRequest } from '#src/desktop/protocol/events/GlyphQuestionRequest.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { css, tokens, space } from './design-system/index.ts';
import { decisionStyles as shared } from './GlyphDecisionStyles.ts';
import { useGlyphDecision } from './useGlyphDecision.ts';

const styles = {
  root: css({
    margin: space('md', 'lg'),
    flexShrink: 0,
    maxHeight: '55%',
    overflowY: 'auto',
    borderColor: tokens.text.warning,
  }),
  body: css({
    padding: space('none', 'lg'),
    border: 0,
    margin: tokens.space.none,
    minWidth: 0,
    '& legend': {
      fontWeight: tokens.font.weight.semibold,
      fontSize: tokens.font.size.heading,
      padding: space('md', 'none'),
      lineHeight: tokens.font.lineHeight.normal,
    },
  }),
  choice: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('md', 'md'),
    borderRadius: tokens.list.radius,
    cursor: 'pointer',
    ':hover': { background: tokens.list.hoverBackground },
    '&:has(input:checked)': {
      background: tokens.list.selected.background,
      color: tokens.list.selected.foreground,
    },
    '& input': { accentColor: tokens.focus.color, margin: tokens.space.none },
  }),
  badge: css({
    fontSize: tokens.font.size.caption,
    border: tokens.border.default,
    borderRadius: tokens.badge.radius,
    padding: space('hairline', 'xs'),
  }),
  other: css({
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    margin: space('md', 'none'),
    minHeight: 64,
    resize: 'vertical',
    padding: tokens.space.md,
    borderRadius: tokens.input.radius,
    border: tokens.input.strongBorder,
    color: tokens.input.foreground,
    background: tokens.input.background,
  }),
};

export function GlyphQuestionCard({
  request,
  chatId,
  runId,
  actions,
  disabled,
  initialAnswers,
  onDraftChange,
}: {
  readonly request: GlyphQuestionRequest;
  readonly chatId: string;
  readonly runId: string;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'answerQuestion' | 'cancel'>;
  readonly disabled: boolean;
  readonly initialAnswers: readonly QuestionAnswer[];
  readonly onDraftChange: (answers: readonly QuestionAnswer[]) => void;
}) {
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
  return (
    <form
      class={`glyph-question-card ${shared.card} ${styles.root}`}
      aria-label="Questions"
      aria-busy={pending}
      onSubmit={event => {
        event.preventDefault();
        continueForm();
      }}
    >
      <header class={shared.header}>
        <span aria-hidden="true">ⓘ</span>
        <h3>{request.title === 'Question' ? 'Questions' : request.title}</h3>
        <span class={shared.detail} aria-live="polite">
          {step + 1} of {questions.length}
        </span>
      </header>
      <fieldset ref={fieldset} class={styles.body} disabled={disabled || pending}>
        <legend>
          {step + 1}. {question.prompt}
        </legend>
        {question.allowMultiple && <p class={shared.detail}>Choose one or more.</p>}
        {question.options.map((option, index) => (
          <label key={option.id} class={styles.choice}>
            <input
              {...(question.allowMultiple ? { type: 'checkbox' as const } : { type: 'radio' as const })}
              name={`${request.id}:${question.id}`}
              checked={answer?.type === QuestionAnswerType.SELECTION && answer.optionIds.includes(option.id)}
              onChange={event => {
                const selected = answer?.type === QuestionAnswerType.SELECTION ? answer.optionIds : [];
                update({
                  questionId: question.id,
                  type: QuestionAnswerType.SELECTION,
                  optionIds: question.allowMultiple
                    ? event.currentTarget.checked
                      ? [...selected, option.id]
                      : selected.filter(id => id !== option.id)
                    : [option.id],
                });
              }}
            />
            <span class={styles.badge} aria-hidden="true">
              {index < 26 ? String.fromCharCode(65 + index) : index + 1}
            </span>
            <span>{option.label}</span>
          </label>
        ))}
        {question.options.length > 0 && (
          <label class={styles.choice}>
            <input
              type="radio"
              name={`${request.id}:${question.id}`}
              checked={other}
              onChange={() => update({ questionId: question.id, type: QuestionAnswerType.OTHER, text: '' })}
            />
            <span>Other…</span>
          </label>
        )}
        {other && (
          <textarea
            class={styles.other}
            aria-label="Your answer"
            placeholder="Type your answer…"
            value={answer?.type === QuestionAnswerType.OTHER ? answer.text : ''}
            onInput={event =>
              update({ questionId: question.id, type: QuestionAnswerType.OTHER, text: event.currentTarget.value })
            }
          />
        )}
      </fieldset>
      <footer class={shared.actions}>
        <button class={shared.button} type="button" disabled={disabled || pending} onClick={() => actions.cancel()}>
          Cancel turn
        </button>
        {step > 0 && (
          <button
            class={`${shared.button} ${shared.secondary}`}
            type="button"
            disabled={disabled || pending}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        <button class={`${shared.button} ${shared.primary}`} type="submit" disabled={disabled || pending || !valid}>
          {pending ? 'Submitting…' : 'Continue'}
        </button>
      </footer>
      {disabled && <p class={shared.error}>Answer in the window that owns this chat.</p>}
      {error && (
        <div class={shared.error} role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
