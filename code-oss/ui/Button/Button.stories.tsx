import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn } from 'storybook/test';
import { ArrowUp, Check, Copy, Plus, ChevronRight } from 'lucide-preact';
import { AgentModeID } from '#src/chat/AgentMode.js';
import {
  Button,
  IconButton,
  ButtonVariant,
  ButtonAppearance,
  ButtonSize,
  ButtonLoadingPosition,
  IconButtonShape,
} from './Button.tsx';
import { SplitButton } from './SplitButton.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({ padding: 24, color: tokens.text.primary, '& h2': { fontSize: 16, margin: '24px 0 12px' } }),
  table: css({
    borderSpacing: '16px 12px',
    '& th': { textAlign: 'left', color: tokens.text.muted, fontWeight: 'normal' },
  }),
  row: css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }),
};
const click = fn().mockName('Button.click');
const meta = {
  title: 'Glyph/Shared/Buttons',
  component: Button,
  globals: { paneWidth: '1000' },
  args: {
    children: 'Button',
    onClick: click,
    variant: ButtonVariant.PRIMARY,
    appearance: ButtonAppearance.FILLED,
    size: ButtonSize.MEDIUM,
    mode: AgentModeID.AGENT,
  },
  argTypes: {
    variant: { control: 'select', options: Object.values(ButtonVariant) },
    appearance: { control: 'select', options: Object.values(ButtonAppearance) },
    size: { control: 'select', options: Object.values(ButtonSize) },
    mode: { control: 'select', options: Object.values(AgentModeID) },
    leadingIcon: { control: false },
    trailingIcon: { control: false },
    shortcut: { control: 'text' },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Canvas: Story = {
  render: ({ mode }) => (
    <div class={styles.root}>
      <h1>Buttons</h1>
      <p>Use the mode control to preview Agent blue and Plan yellow. Outline and Ghost keep neutral text.</p>
      <table class={styles.table}>
        <thead>
          <tr>
            <th>Variant</th>
            {Object.values(ButtonAppearance).map(value => (
              <th key={value}>{value}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.values(ButtonVariant).map(variant => (
            <tr key={variant}>
              <th>{variant}</th>
              {Object.values(ButtonAppearance).map(appearance => (
                <td key={appearance}>
                  <Button
                    variant={variant}
                    appearance={appearance}
                    mode={mode ?? AgentModeID.AGENT}
                    onClick={fn().mockName(`Button.${variant}.${appearance}`)}
                  >
                    {variant}
                  </Button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Icon buttons</h2>
      <div class={styles.row}>
        {Object.values(IconButtonShape).map(shape =>
          Object.values(ButtonAppearance).map(appearance => (
            <IconButton
              key={`${shape}-${appearance}`}
              aria-label={`${shape} ${appearance}`}
              shape={shape}
              appearance={appearance}
              variant={ButtonVariant.PRIMARY}
              mode={mode ?? AgentModeID.AGENT}
              onClick={fn().mockName(`IconButton.${shape}.${appearance}`)}
            >
              <ArrowUp size={16} />
            </IconButton>
          )),
        )}
      </div>
      <h2>Sizes</h2>
      <div class={styles.row}>
        {Object.values(ButtonSize).map(size => (
          <Button key={size} size={size} leadingIcon={<Plus size={16} />} onClick={click}>
            {size}
          </Button>
        ))}
      </div>
      <h2>Icons and shortcuts</h2>
      <div class={styles.row}>
        <Button leadingIcon={<Plus size={16} />} onClick={click}>
          New
        </Button>
        <Button variant={ButtonVariant.CONFIRM} leadingIcon={<Check size={16} />} shortcut="⌘↵" onClick={click}>
          Keep file
        </Button>
        <Button variant={ButtonVariant.CONFIRM} appearance={ButtonAppearance.OUTLINE} shortcut="⇧⌘↵" onClick={click}>
          Keep all changes
        </Button>
        <Button trailingIcon={<ChevronRight size={16} />} onClick={click}>
          Review next file
        </Button>
      </div>
      <h2>States</h2>
      <div class={styles.row}>
        <Button disabled onClick={click}>
          Disabled
        </Button>
        <Button loading onClick={click}>
          Saving
        </Button>
        <Button loading loadingPosition={ButtonLoadingPosition.TRAILING} onClick={click}>
          Building
        </Button>
        <IconButton loading aria-label="Copying" onClick={click}>
          <Copy size={16} />
        </IconButton>
        <IconButton aria-label="Copy selected" aria-pressed={true} onClick={click}>
          <Copy size={16} />
        </IconButton>
      </div>
      <h2>Split action</h2>
      <SplitButton
        variant={ButtonVariant.PRIMARY}
        mode={mode ?? AgentModeID.AGENT}
        shortcut="⌘↵"
        onClick={fn().mockName('SplitButton.build')}
        menuLabel="Build options"
        menu={<Button onClick={fn().mockName('SplitButton.buildNew')}>Build in new chat</Button>}
      >
        Build
      </SplitButton>
    </div>
  ),
};
export const Plan: Story = { ...Canvas, args: { mode: AgentModeID.PLAN } };
