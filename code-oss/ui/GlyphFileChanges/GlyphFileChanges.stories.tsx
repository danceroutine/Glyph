import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn } from 'storybook/test';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { GlyphFileChanges } from './GlyphFileChanges.tsx';
const meta = {
  title: 'Glyph/Chat/In Transcript/File changes',
  component: GlyphFileChanges,
  args: {
    review: fn(),
    files: (['CREATE', 'DELETE', 'RENAME'] as const).map((operation, index) => ({
      id: `${index}`,
      path: ['created.json', 'deleted.txt', 'renamed.ts'][index]!,
      proposedUri: '',
      pendingItemIds: [`${index}`],
      operation,
      autoApplied: true,
      applicability: GlyphProposalApplicability.READY,
      beforePreview: 'coffee\noat milk\nsourdough\nlemons',
      afterPreview: operation === 'CREATE' ? '{\n  "name": "example",\n  "enabled": true\n}' : 'const renamed = true;',
      additions: operation === 'CREATE' ? 4 : 0,
      deletions: operation === 'DELETE' ? 4 : 0,
    })),
  },
} satisfies Meta<typeof GlyphFileChanges>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Applied: Story = {};
