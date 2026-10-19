import { ChevronDown, Check } from 'lucide-preact';
import { AgentMode } from '#src/chat/AgentMode.js';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';
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
  const mode = AgentMode.resolve(state.mode);
  const presentation = AGENT_MODE_PRESENTATION[mode.id];
  const Icon = presentation.Icon;
  return (
    <div class={styles.root} ref={state.root} onBlur={event => state.blur(event.relatedTarget)}>
      <button
        type="button"
        class={styles.trigger}
        data-mode={state.mode}
        style={presentation.badge}
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
        <Icon />
        {mode.name}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {state.open && (
        <div id={state.id} role="listbox" aria-label="Conversation modes" class={styles.menu}>
          {state.modes.map(mode => {
            const OptionIcon = AGENT_MODE_PRESENTATION[mode.id].Icon;
            return (
              <button
                type="button"
                key={mode.id}
                id={`${state.id}-${mode.id}`}
                role="option"
                aria-selected={state.mode === mode.id}
                tabIndex={-1}
                class={styles.option}
                data-highlighted={state.highlighted === mode.id}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => state.setHighlighted(mode.id)}
                onClick={() => state.select(mode.id)}
              >
                <OptionIcon />
                <span>{mode.name}</span>
                {state.mode === mode.id && <Check size={16} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
