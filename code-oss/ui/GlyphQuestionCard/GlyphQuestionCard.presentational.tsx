import { MessageCircleQuestion, ChevronUp, ChevronDown } from 'lucide-preact';
import type { GlyphQuestionCardState } from './useGlyphQuestionCardState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import { decisionStyles as shared } from '#code-oss/ui/GlyphDecisionStyles.ts';

const styles = {
  root: css({
    margin: space('md', 'lg'),
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    maxHeight: 'calc(100% - 24px)',
    overflow: 'hidden',
    borderColor: `color-mix(in srgb, ${tokens.text.warning} 35%, transparent)`,
  }),
  counter: css({ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }),
  navigation: css({
    border: 0,
    background: 'transparent',
    color: tokens.text.muted,
    padding: 2,
    display: 'inline-flex',
    cursor: 'pointer',
    ':disabled': { opacity: 0.35, cursor: 'default' },
  }),
  continue: css({ background: tokens.text.warning, color: '#1e1e1e', ':disabled': { opacity: 0.45 } }),
  viewport: css({
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    minHeight: 0,
    maxHeight: 'min(360px, 40vh)',
    position: 'relative',
    scrollbarGutter: 'stable',
    '& > fieldset:last-child:not(:first-child)': { minHeight: 'min(360px, 40vh)', boxSizing: 'border-box' },
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
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('md', 'md'),
    borderRadius: tokens.list.radius,
    cursor: 'pointer',
    ':hover': { background: tokens.list.hoverBackground },
    '&:has(input:checked)': {
      color: tokens.text.primary,
    },
    '& input': { position: 'absolute', opacity: 0, width: 20, height: 20, margin: 0 },
    '&:has(input:focus-visible)': { outline: tokens.focus.ring },
    '& input:checked + span': { background: tokens.text.warning, borderColor: tokens.text.warning, color: '#1e1e1e' },
  }),
  badge: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 20,
    height: 20,
    boxSizing: 'border-box',
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
  questions,
  questionNumber,
  questionCount,
  viewport,
  trackScroll,
  disabled,
  pending,
  error,
  valid,
  continueForm,
  cancel,
  back,
  next,
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
        <MessageCircleQuestion size={18} aria-hidden="true" />
        <h3>{title}</h3>
        <span class={`${shared.detail} ${styles.counter}`} aria-live="polite">
          <button
            class={styles.navigation}
            type="button"
            aria-label="Previous question"
            disabled={disabled || pending || questionNumber === 1}
            onClick={back}
          >
            <ChevronUp size={16} />
          </button>
          {questionNumber} of {questionCount}
          <button
            class={styles.navigation}
            type="button"
            aria-label="Next question"
            disabled={disabled || pending || questionNumber === questionCount}
            onClick={next}
          >
            <ChevronDown size={16} />
          </button>
        </span>
      </header>
      <div ref={viewport} class={`glyph-question-scroll ${styles.viewport}`} onScroll={trackScroll}>
        {questions.map(
          (
            {
              question,
              inputName,
              fieldset,
              activate,
              other,
              selectedOptionIds,
              otherText,
              selectOption,
              enterOther,
              updateOther,
            },
            index,
          ) => (
            <fieldset
              key={question.id}
              ref={fieldset}
              class={styles.body}
              disabled={disabled || pending}
              onFocusIn={activate}
            >
              <legend>
                {index + 1}. {question.prompt}
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
                  <span class={styles.badge} aria-hidden="true">
                    {question.options.length < 26
                      ? String.fromCharCode(65 + question.options.length)
                      : question.options.length + 1}
                  </span>
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
          ),
        )}
      </div>
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
        <button class={`${shared.button} ${styles.continue}`} type="submit" disabled={disabled || pending || !valid}>
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
