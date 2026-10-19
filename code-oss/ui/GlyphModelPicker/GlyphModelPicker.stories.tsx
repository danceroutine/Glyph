import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn, userEvent, within } from 'storybook/test';
import { useState } from 'preact/hooks';
import { GlyphModelPicker, type GlyphModelPickerProps } from './GlyphModelPicker.presentational.tsx';
function Example(args: GlyphModelPickerProps) {
  const [model, setModel] = useState(args.model);
  return (
    <GlyphModelPicker
      {...args}
      model={model}
      label={args.models.find(item => item.value === model)?.label ?? args.label}
      selectModel={value => {
        setModel(value);
        args.selectModel(value);
      }}
    />
  );
}
const meta = {
  title: 'Glyph/Chat/In Composer/Model Picker',
  component: GlyphModelPicker,
  args: {
    model: 'auto',
    label: 'Auto',
    disabled: false,
    models: [
      { value: 'auto', label: 'Auto' },
      { value: 'fast', label: 'Fast' },
      { value: 'balanced', label: 'Balanced' },
    ],
    selectModel: fn().mockName('ModelPicker.selectModel'),
  },
  render: args => <Example {...args} />,
  decorators: [
    Story => (
      <div style={{ padding: '240px 24px 24px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GlyphModelPicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Menu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox', { name: 'Model' }));
  },
};
export const LockedToConversation: Story = { args: { disabled: true } };
export const Unavailable: Story = { args: { model: '', label: 'No model available', models: [], disabled: true } };
