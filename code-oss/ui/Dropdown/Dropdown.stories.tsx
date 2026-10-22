import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn, userEvent, within } from 'storybook/test';
import { useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { Dropdown } from './Dropdown.tsx';
import { useDropdownState } from './useDropdownState.ts';

function DropdownExample({
  items,
  disabled,
  busy,
  onSelect,
}: {
  readonly items: readonly string[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSelect: (value: string) => void;
}) {
  const [selected, setSelected] = useState(items[0]);
  const state = useDropdownState({
    items: busy ? [] : items,
    selectedIndex: items.indexOf(selected ?? ''),
    label: value => value,
    disabled,
    choose: value => {
      setSelected(value);
      onSelect(value);
    },
  });
  return (
    <div style={{ padding: '380px 24px 24px' }}>
      <div
        ref={state.root}
        style={{ position: 'relative', width: 180 }}
        onBlur={event => {
          state.blur(event.relatedTarget);
        }}
      >
        <Button
          buttonRef={state.trigger}
          appearance={ButtonAppearance.GHOST}
          role="combobox"
          aria-label="Example choice"
          disabled={disabled}
          aria-expanded={state.open}
          aria-haspopup="listbox"
          aria-controls={state.open ? state.id : undefined}
          aria-activedescendant={state.open && state.activeIndex >= 0 ? `${state.id}-${state.activeIndex}` : undefined}
          onClick={state.toggle}
          onKeyDown={state.keydown}
        >
          {selected ?? 'Choose…'}
          <ChevronDown size={14} />
        </Button>
        {state.open && (
          <Dropdown
            id={state.id}
            label="Example choices"
            heading="Choices"
            items={items}
            itemKey={value => value}
            itemLabel={value => value}
            renderItem={value => <span>{value}</span>}
            activeIndex={state.activeIndex}
            selectedIndex={items.indexOf(selected ?? '')}
            highlight={state.highlight}
            choose={state.select}
            busy={busy}
            showCheck
          />
        )}
      </div>
    </div>
  );
}
const meta = {
  title: 'Glyph/Shared/Dropdown',
  component: DropdownExample,
  args: {
    items: ['Auto', 'Balanced', 'Fast', 'Thorough'],
    disabled: false,
    busy: false,
    onSelect: fn().mockName('Dropdown.select'),
  },
} satisfies Meta<typeof DropdownExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Closed: Story = {};
export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox'));
  },
};
export const LongList: Story = {
  ...Open,
  args: { items: Array.from({ length: 40 }, (_, index) => `Choice ${index + 1}`) },
};
export const Empty: Story = { ...Open, args: { items: [] } };
export const Loading: Story = { ...Open, args: { busy: true } };
export const Disabled: Story = { args: { disabled: true } };
