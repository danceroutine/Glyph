import { useId, useRef, useState } from 'preact/hooks';
import { ChevronUp, SquareTerminal } from 'lucide-preact';
import type { GlyphBackgroundShell } from '#src/desktop/protocol/events/GlyphBackgroundShell.ts';
import { Button, ButtonAppearance, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { composerDrawerStyles as drawer } from '#code-oss/ui/GlyphComposer/GlyphComposerDrawer.styles.ts';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  rows: css({ padding: '0 12px 8px', maxHeight: 210, overflowY: 'auto' }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    borderRadius: 6,
    ':hover, :focus-within': { background: tokens.button.secondary.hoverBackground },
    '& .glyph-shell-stop': { opacity: 0 },
    '&:hover .glyph-shell-stop, &:focus-within .glyph-shell-stop': { opacity: 1 },
    '@media (hover: none)': { '& .glyph-shell-stop': { opacity: 1 } },
  }),
  open: css({ '&&': { flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', borderRadius: 0 } }),
  title: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  wake: css({
    color: tokens.text.muted,
    fontSize: tokens.font.size.caption,
    padding: '0 8px 6px',
    overflowWrap: 'anywhere',
  }),
};

export interface GlyphBackgroundTerminalsProps {
  readonly shells: readonly GlyphBackgroundShell[];
  readonly disabled?: boolean;
  readonly open: (shell: GlyphBackgroundShell) => Promise<void>;
  readonly stop: (shell: GlyphBackgroundShell) => Promise<void>;
}

/** Live processes occupy one drawer above the queued drafts. */
export function GlyphBackgroundTerminals({ shells, disabled, open, stop }: GlyphBackgroundTerminalsProps) {
  const [expanded, setExpanded] = useState(false);
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState('');
  const listId = useId();
  const running = shells.filter(shell => shell.running);
  if (running.length === 0) return null;
  const act = async (shell: GlyphBackgroundShell, action: typeof open) => {
    if (disabled === true || inFlight.current.has(shell.id)) return;
    inFlight.current.add(shell.id);
    setPending(values => [...values, shell.id]);
    setError('');
    try {
      await action(shell);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current.delete(shell.id);
      setPending(values => values.filter(id => id !== shell.id));
    }
  };
  return (
    <section class={`glyph-background-terminals ${drawer.card}`} aria-label="Background terminals">
      <Button
        appearance={ButtonAppearance.GHOST}
        class={`${drawer.header} ${drawer.toggle}`}
        data-drawer-header
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        <ChevronUp size={16} class={drawer.chevron} data-expanded={expanded || undefined} aria-hidden="true" />
        {running.length} background {running.length === 1 ? 'terminal' : 'terminals'}
      </Button>
      <div class={drawer.reveal} data-expanded={expanded || undefined} aria-hidden={!expanded} inert={!expanded}>
        <div class={drawer.clip}>
          <div id={listId} class={styles.rows} role="list">
            {running.map(shell => (
              <div key={shell.id} role="listitem">
                <div class={styles.row}>
                  <Button
                    appearance={ButtonAppearance.GHOST}
                    class={styles.open}
                    title={`Open terminal: ${shell.command}`}
                    disabled={disabled === true || pending.includes(shell.id)}
                    onClick={() => void act(shell, open)}
                  >
                    <SquareTerminal size={18} aria-hidden="true" />
                    <span class={styles.title}>{shell.command}</span>
                  </Button>
                  <Button
                    appearance={ButtonAppearance.GHOST}
                    size={ButtonSize.SMALL}
                    class="glyph-shell-stop"
                    disabled={disabled === true || pending.includes(shell.id)}
                    onClick={() => void act(shell, stop)}
                  >
                    Stop
                  </Button>
                </div>
                {shell.wakePattern !== undefined && shell.wakePattern !== '' && (
                  <div class={styles.wake}>
                    Wake on: <code>{shell.wakePattern}</code>
                  </div>
                )}
              </div>
            ))}
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
