import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { ChevronDown, ChevronRight, SquareTerminal } from 'lucide-preact';
import type { GlyphShellCommandCardState } from './useGlyphShellCommandCardState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

const styles = {
  card: css({
    marginTop: tokens.space.lg,
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    overflow: 'hidden',
    background: tokens.surface.pane,
    whiteSpace: 'normal',
    minWidth: 0,
  }),
  header: css({
    '&&': {
      display: 'flex',
      width: '100%',
      gap: tokens.space.md,
      padding: space('lg', 'lg'),
      border: 0,
      textAlign: 'left',
    },
    ':focus-visible': { outlineOffset: tokens.focus.inset },
  }),
  title: css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  status: css({ fontSize: tokens.font.size.caption, flexShrink: 0 }),
  body: css({ borderTop: tokens.border.default, padding: space('md', 'lg'), overflowWrap: 'anywhere' }),
  output: css({
    margin: 0,
    fontFamily: tokens.font.family.code,
    fontSize: tokens.font.size.body,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: 320,
    overflowY: 'auto',
    userSelect: 'text',
    color: tokens.text.muted,
  }),
  command: css({
    margin: space('none', 'none', 'md'),
    color: tokens.text.primary,
    fontFamily: tokens.font.family.code,
    whiteSpace: 'pre-wrap',
    userSelect: 'text',
  }),
  details: css({ fontSize: tokens.font.size.detail, color: tokens.text.muted, margin: space('md', 'none') }),
  error: css({ color: tokens.text.error, whiteSpace: 'pre-wrap' }),
  input: css({
    boxSizing: 'border-box',
    width: '100%',
    resize: 'vertical',
    padding: tokens.space.md,
    background: tokens.input.background,
    color: tokens.input.foreground,
    border: tokens.input.border,
    borderRadius: tokens.input.radius,
    font: 'inherit',
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  controls: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.space.md,
    marginTop: tokens.space.md,
  }),
};

export function GlyphShellCommandCard({
  shell,
  expanded,
  preview,
  status,
  failed,
  toggle,
  input,
  appendNewline,
  pending,
  disabled,
  canSend,
  changeInput,
  changeAppendNewline,
  sendInput,
  close,
  error,
}: GlyphShellCommandCardState) {
  return (
    <section
      class={`glyph-shell-command ${styles.card}`}
      aria-label="Shell command"
      data-live={shell.live}
      aria-busy={pending}
    >
      <Button
        appearance={ButtonAppearance.GHOST}
        type="button"
        class={styles.header}
        aria-expanded={expanded}
        onClick={toggle}
      >
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <SquareTerminal size={16} aria-hidden="true" />
        <span class={styles.title}>{shell.command}</span>
        <span class={`${styles.status} ${failed ? styles.error : ''}`}>{status}</span>
      </Button>
      <div class={styles.body}>
        {shell.wakePattern !== undefined && shell.wakePattern !== '' && (
          <div class={styles.details}>
            Wake on: <code>{shell.wakePattern}</code>
          </div>
        )}
        {expanded && <pre class={styles.command}>$ {shell.command}</pre>}
        <pre class={styles.output} aria-label="Command output">
          {expanded ? shell.output : preview}
        </pre>
        {expanded && shell.workingDirectory !== undefined && shell.workingDirectory !== '' && (
          <p class={styles.details}>Working directory: {shell.workingDirectory}</p>
        )}
        {shell.error !== undefined && shell.error !== '' && <p class={styles.error}>{shell.error}</p>}
        {expanded && shell.live && (
          <>
            {shell.running && (
              <form
                aria-label="Shell input"
                onSubmit={event => {
                  event.preventDefault();
                  sendInput();
                }}
              >
                <textarea
                  class={styles.input}
                  aria-label="Input to shell"
                  value={input}
                  maxLength={65536}
                  disabled={disabled}
                  onInput={event => {
                    changeInput(event.currentTarget.value);
                  }}
                />
                <div class={styles.controls}>
                  <label>
                    <input
                      type="checkbox"
                      checked={appendNewline}
                      disabled={disabled}
                      onChange={event => {
                        changeAppendNewline(event.currentTarget.checked);
                      }}
                    />{' '}
                    Append newline
                  </label>
                  <Button type="submit" disabled={!canSend}>
                    Send input
                  </Button>
                </div>
              </form>
            )}
            <div class={styles.controls}>
              <Button type="button" disabled={disabled} onClick={close}>
                Close shell
              </Button>
            </div>
          </>
        )}
        {error !== undefined && error !== '' && (
          <p class={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
