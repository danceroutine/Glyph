import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphReviewControls } from './GlyphReviewControls.wired.tsx';
const meta = {
  title: 'Glyph/Editor review controls',
  component: WiredGlyphReviewControls,
  args: {
    label: '1 of 2',
    fileLabel: '1 of 2 Files',
    disabled: false,
    keepDisabled: false,
    previous: () => {},
    next: () => {},
    previousFile: async () => {},
    nextFile: async () => {},
    keep: async () => {},
    undo: async () => {},
    keepFile: async () => {},
    undoFile: async () => {},
    keepAll: async () => {},
  },
} satisfies Meta<typeof WiredGlyphReviewControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FileToolbar: Story = {};
export const Hunk: Story = {
  render: ({ label, disabled, keepDisabled, previous, next, keep, undo }) => (
    <WiredGlyphReviewControls
      label={label}
      itemId="example-hunk"
      shortcutModifier="⌘"
      rejectWithComment={async () => {}}
      disabled={disabled}
      keepDisabled={keepDisabled}
      previous={previous}
      next={next}
      keep={keep}
      undo={undo}
    />
  ),
};
