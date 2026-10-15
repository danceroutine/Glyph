import type { GlyphQuestionCardState } from './useGlyphQuestionCardState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import { decisionStyles as shared } from '#code-oss/ui/GlyphDecisionStyles.ts';

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

export type GlyphQuestionCardProps = GlyphQuestionCardState;

export function GlyphQuestionCard({
  title,
  question,
  questionNumber,
  questionCount,
  inputName,
  fieldset,
  other,
  selectedOptionIds,
  otherText,
  disabled,
  pending,
  error,
  valid,
  continueForm,
  selectOption,
  enterOther,
  updateOther,
  cancel,
  back,
}: GlyphQuestionCardProps) {
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
        <h3>{title}</h3>
        <span class={shared.detail} aria-live="polite">
          {questionNumber} of {questionCount}
        </span>
      </header>
      <fieldset ref={fieldset} class={styles.body} disabled={disabled || pending}>
        <legend>
          {questionNumber}. {question.prompt}
        </legend>
        {question.allowMultiple && <p class={shared.detail}>Choose one or more.</p>}
        {question.options.map((option, index) => (
          <label key={option.id} class={styles.choice}>
            <input
              {...(question.allowMultiple ? { type: 'checkbox' as const } : { type: 'radio' as const })}
              name={inputName}
              checked={selectedOptionIds.includes(option.id)}
              onChange={event => selectOption(option.id, event.currentTarget.checked)}
            />
            <span class={styles.badge} aria-hidden="true">
              {index < 26 ? String.fromCharCode(65 + index) : index + 1}
            </span>
            <span>{option.label}</span>
          </label>
        ))}
        {question.options.length > 0 && (
          <label class={styles.choice}>
            <input type="radio" name={inputName} checked={other} onChange={enterOther} />
            <span>Other…</span>
          </label>
        )}
        {other && (
          <textarea
            class={styles.other}
            aria-label="Your answer"
            placeholder="Type your answer…"
            value={otherText}
            onInput={event => updateOther(event.currentTarget.value)}
          />
        )}
      </fieldset>
      <footer class={shared.actions}>
        <button class={shared.button} type="button" disabled={disabled || pending} onClick={cancel}>
          Cancel turn
        </button>
        {questionNumber > 1 && (
          <button
            class={`${shared.button} ${shared.secondary}`}
            type="button"
            disabled={disabled || pending}
            onClick={back}
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
