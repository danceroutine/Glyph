import { List, ChevronDown, Check } from 'lucide-preact';
import { GlyphAgentIcon } from './GlyphAgentIcon.presentational.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphModePickerState } from './useGlyphModePickerState.ts';
const styles = {
  root: css({ position: 'relative', flexShrink: 0 }),
  trigger: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    padding: '3px 9px',
    border: 0,
    borderRadius: 999,
    font: 'inherit',
    cursor: 'pointer',
    color: tokens.text.muted,
    background: tokens.button.secondary.background,
    '&[data-mode=plan]': {
      color: tokens.text.warning,
      background: `color-mix(in srgb, ${tokens.text.warning} 24%, transparent)`,
    },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  menu: css({
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 20,
    width: 180,
    padding: tokens.space.xs,
    border: tokens.dropdown.border,
    borderRadius: tokens.input.radius,
    background: tokens.dropdown.background,
    color: tokens.dropdown.foreground,
  }),
  option: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    width: '100%',
    padding: '5px 8px',
    border: 0,
    borderRadius: tokens.button.radius,
    font: 'inherit',
    textAlign: 'left',
    color: 'inherit',
    background: 'transparent',
    cursor: 'pointer',
    '&[data-highlighted=true]': { background: tokens.list.hoverBackground },
    '& > span:not(.glyph-agent-icon)': { flex: 1 },
  }),
};
export function GlyphModePicker(state: GlyphModePickerState) {
  return (
    <div class={styles.root} ref={state.root} onBlur={event => state.blur(event.relatedTarget)}>
      <button
        type="button"
        class={styles.trigger}
        data-mode={state.mode}
        ref={state.trigger}
        role="combobox"
        aria-label="Conversation mode"
        aria-expanded={state.open}
        aria-controls={state.open ? state.id : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={state.open ? `${state.id}-${state.highlighted}` : undefined}
        onClick={state.toggle}
        onKeyDown={state.keydown}
      >
        {state.mode === 'plan' ? <List size={16} aria-hidden="true" /> : <GlyphAgentIcon />}
        {state.mode === 'plan' ? 'Plan' : 'Agent'}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {state.open && (
        <div id={state.id} role="listbox" aria-label="Conversation modes" class={styles.menu}>
          {(['agent', 'plan'] as const).map(mode => (
            <button
              type="button"
              key={mode}
              id={`${state.id}-${mode}`}
              role="option"
              aria-selected={state.mode === mode}
              tabIndex={-1}
              class={styles.option}
              data-highlighted={state.highlighted === mode}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => state.setHighlighted(mode)}
              onClick={() => state.select(mode)}
            >
              {mode === 'plan' ? <List size={16} aria-hidden="true" /> : <GlyphAgentIcon />}
              <span>{mode === 'plan' ? 'Plan' : 'Agent'}</span>
              {state.mode === mode && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
