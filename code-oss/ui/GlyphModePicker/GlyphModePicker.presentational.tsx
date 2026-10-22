import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { Button } from '#code-oss/ui/Button/Button.tsx';
import { ChevronDown } from 'lucide-preact';
import { AgentMode } from '#src/chat/AgentMode.js';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphModePickerState } from './useGlyphModePickerState.ts';
const styles = {
  root: css({ position: 'relative', flexShrink: 0 }),
  trigger: css({
    '&&': { gap: tokens.space.xs, padding: '3px 9px', borderRadius: 999 },
  }),
};
export function GlyphModePicker(state: GlyphModePickerState) {
  const mode = AgentMode.resolve(state.mode);
  const presentation = AGENT_MODE_PRESENTATION[mode.id];
  const Icon = presentation.Icon;
  return (
    <div
      class={styles.root}
      ref={state.root}
      onBlur={event => {
        state.blur(event.relatedTarget);
      }}
    >
      <Button
        type="button"
        class={styles.trigger}
        data-mode={state.mode}
        style={presentation.badge}
        buttonRef={state.trigger}
        role="combobox"
        aria-label="Conversation mode"
        aria-expanded={state.open}
        aria-controls={state.open ? state.id : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={state.open ? `${state.id}-${state.activeIndex}` : undefined}
        onClick={state.toggle}
        onKeyDown={state.keydown}
      >
        <Icon />
        {mode.name}
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {state.open && (
        <Dropdown
          id={state.id}
          label="Conversation modes"
          items={state.modes}
          itemKey={option => option.id}
          itemLabel={option => option.name}
          activeIndex={state.activeIndex}
          selectedIndex={state.selectedIndex}
          highlight={state.highlight}
          choose={state.select}
          showCheck
          width={180}
          renderItem={option => {
            const OptionIcon = AGENT_MODE_PRESENTATION[option.id].Icon;
            return (
              <>
                <OptionIcon />
                <span>{option.name}</span>
              </>
            );
          }}
        />
      )}
    </div>
  );
}
