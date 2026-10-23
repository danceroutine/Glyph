import { ChevronDown } from 'lucide-preact';
import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { useDropdownState } from '#code-oss/ui/Dropdown/useDropdownState.ts';
import type { GlyphModelPickerState } from './useGlyphModelPickerState.ts';
import { css } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({ position: 'relative', minWidth: 0 }),
  trigger: css({ maxWidth: '100%', minWidth: 0 }),
  label: css({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
};
export type GlyphModelPickerProps = GlyphModelPickerState;
export function GlyphModelPicker({ model, label, disabled, models, selectModel }: GlyphModelPickerProps) {
  const selectedIndex = models.findIndex(item => item.value === model);
  const dropdown = useDropdownState({
    items: models,
    selectedIndex,
    label: item => item.label,
    choose: item => {
      selectModel(item.value);
    },
    disabled,
  });
  return (
    <div
      ref={dropdown.root}
      class={`glyph-model-picker ${styles.root}`}
      onBlur={event => {
        dropdown.blur(event.relatedTarget);
      }}
    >
      <Button
        buttonRef={dropdown.trigger}
        class={styles.trigger}
        appearance={ButtonAppearance.GHOST}
        role="combobox"
        aria-label="Model"
        title={label}
        disabled={disabled}
        aria-expanded={dropdown.open}
        aria-haspopup="listbox"
        aria-controls={dropdown.open ? dropdown.id : undefined}
        aria-activedescendant={
          dropdown.open && dropdown.activeIndex >= 0 ? `${dropdown.id}-${dropdown.activeIndex}` : undefined
        }
        onClick={dropdown.toggle}
        onKeyDown={dropdown.keydown}
      >
        <span class={styles.label}>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {dropdown.open && (
        <Dropdown
          id={dropdown.id}
          label="Models"
          items={models}
          itemKey={item => item.value}
          itemLabel={item => item.label}
          renderItem={item => <span class={styles.label}>{item.label}</span>}
          activeIndex={dropdown.activeIndex}
          selectedIndex={selectedIndex}
          highlight={dropdown.highlight}
          choose={dropdown.select}
          showCheck
        />
      )}
    </div>
  );
}
