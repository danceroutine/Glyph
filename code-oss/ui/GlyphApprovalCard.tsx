import type { GlyphApprovalRequest } from '#src/desktop/protocol/events/GlyphApprovalRequest.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css } from './emotion.ts';
import { decisionStyles as shared } from './GlyphDecisionStyles.ts';
import { useGlyphDecision } from './useGlyphDecision.ts';

const styles = {
  root: css({ marginTop: 12 }),
  command: css({
    margin: 0,
    padding: '12px 14px',
    borderTop: '1px solid var(--vscode-panel-border, #555)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 13,
    userSelect: 'text',
  }),
  detail: css({ padding: '0 14px', whiteSpace: 'pre-wrap' }),
};

export function GlyphApprovalCard({
  request,
  chatId,
  runId,
  actions,
  disabled,
}: {
  readonly request: GlyphApprovalRequest;
  readonly chatId: string;
  readonly runId: string;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'decideApproval'>;
  readonly disabled: boolean;
}) {
  const { pending, error, submit } = useGlyphDecision();
  const decide = (decision: GlyphApprovalDecision) => {
    if (!disabled) void submit(() => actions.decideApproval(chatId, runId, request.id, decision));
  };
  return (
    <section
      class={`glyph-approval-card ${shared.card} ${styles.root}`}
      aria-label="Command approval"
      aria-busy={pending}
    >
      <header class={shared.header}>
        <span aria-hidden="true">›_</span>
        <h3>{request.title}</h3>
        <span class={shared.detail}>Pending approval</span>
      </header>
      <pre class={styles.command}>{request.command ?? request.detail}</pre>
      {request.workingDirectory && (
        <p class={`${shared.detail} ${styles.detail}`}>Working directory: {request.workingDirectory}</p>
      )}
      {request.canRemember && (
        <p class={`${shared.detail} ${styles.detail}`}>Always Run remembers this exact command in this directory.</p>
      )}
      <div class={shared.actions}>
        <button
          class={shared.button}
          type="button"
          disabled={disabled || pending}
          onClick={() => decide(GlyphApprovalDecision.DENY)}
        >
          Skip
        </button>
        {request.canRemember && (
          <button
            class={`${shared.button} ${shared.secondary}`}
            type="button"
            disabled={disabled || pending}
            onClick={() => decide(GlyphApprovalDecision.ALWAYS_ALLOW)}
          >
            Always Run
          </button>
        )}
        <button
          class={`${shared.button} ${shared.primary}`}
          type="button"
          disabled={disabled || pending}
          onClick={() => decide(GlyphApprovalDecision.ALLOW_ONCE)}
        >
          {pending ? 'Submitting…' : 'Run'}
        </button>
      </div>
      {disabled && <p class={shared.error}>Approve in the window that owns this chat.</p>}
      {error && (
        <div class={shared.error} role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
