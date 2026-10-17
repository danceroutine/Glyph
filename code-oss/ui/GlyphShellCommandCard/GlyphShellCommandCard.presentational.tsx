import { ChevronDown, ChevronRight } from 'lucide-preact';
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
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    gap: tokens.space.md,
    padding: space('lg', 'lg'),
    border: 0,
    background: 'transparent',
    color: tokens.text.muted,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.button.quiet.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
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
  button: css({
    padding: space('xs', 'md'),
    border: 0,
    borderRadius: tokens.button.radius,
    background: tokens.button.secondary.background,
    color: tokens.button.secondary.foreground,
    font: 'inherit',
    cursor: 'pointer',
    ':disabled': { opacity: tokens.opacity.disabled, cursor: 'default' },
    ':focus-visible': { outline: tokens.focus.ring },
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
      <button type="button" class={styles.header} aria-expanded={expanded} onClick={toggle}>
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span class={styles.title}>{shell.command}</span>
        <span class={`${styles.status} ${failed ? styles.error : ''}`}>{status}</span>
      </button>
      <div class={styles.body}>
        {expanded && <pre class={styles.command}>$ {shell.command}</pre>}
        <pre class={styles.output} aria-label="Command output">
          {expanded ? shell.output : preview}
        </pre>
        {expanded && shell.workingDirectory && (
          <p class={styles.details}>Working directory: {shell.workingDirectory}</p>
        )}
        {shell.error && <p class={styles.error}>{shell.error}</p>}
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
                  onInput={event => changeInput(event.currentTarget.value)}
                />
                <div class={styles.controls}>
                  <label>
                    <input
                      type="checkbox"
                      checked={appendNewline}
                      disabled={disabled}
                      onChange={event => changeAppendNewline(event.currentTarget.checked)}
                    />{' '}
                    Append newline
                  </label>
                  <button type="submit" class={styles.button} disabled={!canSend}>
                    Send input
                  </button>
                </div>
              </form>
            )}
            <div class={styles.controls}>
              <button type="button" class={styles.button} disabled={disabled} onClick={close}>
                Close shell
              </button>
            </div>
          </>
        )}
        {error && (
          <p class={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
