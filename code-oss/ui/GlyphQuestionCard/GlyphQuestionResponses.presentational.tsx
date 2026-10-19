import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  card: css({
    '& dl': { margin: 0 },
    background: tokens.input.background,
    border: tokens.input.strongBorder,
    borderRadius: 12,
    padding: '0 12px',
    margin: '12px 0 20px',
  }),
  row: css({ padding: '12px 0', '& + &': { borderTop: tokens.border.default } }),
  question: css({ color: tokens.text.muted, fontWeight: tokens.font.weight.semibold, margin: '0 0 6px' }),
  answer: css({ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
};

export function GlyphQuestionResponses({ response }: { readonly response: GlyphQuestionResponse }) {
  return (
    <section class={styles.card} aria-label="Submitted answers">
      <dl>
        {response.answers.map((answer, index) => (
          <div class={styles.row} key={index}>
            <dt class={styles.question}>{answer.question}</dt>
            <dd class={styles.answer}>{answer.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
