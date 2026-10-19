import type { GlyphAgentReviewFinding } from '#src/desktop/workbench/GlyphAgentReviewFinding.js';
import { Button, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const card = css({
  padding: 12,
  border: tokens.border.default,
  borderRadius: tokens.input.radius,
  background: tokens.surface.canvas,
  color: tokens.text.primary,
  fontFamily: tokens.font.family.body,
  fontSize: tokens.font.size.body,
  boxSizing: 'border-box',
  overflow: 'auto',
  '& p': { whiteSpace: 'pre-wrap', margin: '8px 0' },
});
export function GlyphAgentReviewComment({
  finding,
  fix,
  dismiss,
}: {
  readonly finding: GlyphAgentReviewFinding;
  readonly fix: () => void;
  readonly dismiss: () => void;
}) {
  return (
    <section class={card} aria-label="Agent review comment">
      <strong>{finding.title}</strong>
      <p>{finding.body}</p>
      <Button variant={ButtonVariant.PRIMARY} onClick={fix}>
        Fix with Agent
      </Button>{' '}
      <Button onClick={dismiss}>Dismiss</Button>
    </section>
  );
}
