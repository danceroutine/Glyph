import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn, userEvent, within, expect } from 'storybook/test';
import { GlyphAgentReviewScope } from '#src/desktop/workbench/GlyphAgentReview.js';
import { GlyphAgentReview } from './GlyphAgentReview.presentational.tsx';
const meta = {
  title: 'Glyph/Workbench/Agent Review',
  component: GlyphAgentReview,
  args: {
    scope: GlyphAgentReviewScope.LAST_COMMIT,
    branch: '',
    busy: false,
    chooseScope: fn(),
    review: fn(),
    fixAll: fn(),
  },
} satisfies Meta<typeof GlyphAgentReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LastCommit: Story = {};
export const StagedChanges: Story = { args: { scope: GlyphAgentReviewScope.STAGED } };
export const AllLocalChanges: Story = { args: { scope: GlyphAgentReviewScope.ALL_LOCAL } };
export const CompareBranch: Story = { args: { scope: GlyphAgentReviewScope.BRANCH, branch: 'refs/heads/main' } };
export const Capturing: Story = { args: { busy: true } };
export const Unavailable: Story = {
  args: { unavailableReason: 'Git history is unavailable. Create a commit to review.' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Find Issues' })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: 'Review scope' })).toBeDisabled();
    await expect(args.chooseScope).not.toHaveBeenCalled();
    await expect(args.review).not.toHaveBeenCalled();
  },
};
export const ScopePicker: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Review scope' }));
    await userEvent.click(canvas.getByRole('option', { name: 'Staged changes' }));
    await expect(args.chooseScope).toHaveBeenCalledWith(GlyphAgentReviewScope.STAGED);
  },
};
export const Reviewing: Story = { args: { reviewing: true, stop: fn() } };
export const Findings: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fix All Issues' }));
    await expect(args.fixAll).toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Review Again' }));
    await expect(args.review).toHaveBeenCalled();
  },
  args: {
    completed: true,
    resultScope: 'Last commit',
    findings: [
      {
        id: '1',
        path: 'src/parser.ts',
        line: 12,
        title: 'Empty input is indexed before validation',
        body: 'The parser reads the first element before checking whether input is empty.',
      },
      {
        id: '2',
        path: 'src/storage.json',
        line: 2,
        title: 'The default location is outside the workspace',
        body: 'The configured path escapes the project directory.',
      },
    ],
    openFinding: fn(),
    fixFinding: fn(),
    dismissFinding: fn(),
  },
};

export const CleanReview: Story = { args: { completed: true, findings: [], resultScope: 'Last commit' } };
export const Interrupted: Story = {
  args: { error: 'The review was interrupted when the host stopped. Review again to retry.' },
};
