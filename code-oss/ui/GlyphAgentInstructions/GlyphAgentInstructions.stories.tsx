import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn } from 'storybook/test';
import { GlyphAgentInstructions } from './GlyphAgentInstructions.presentational.tsx';

const meta = {
  title: 'Glyph/Editor/Agent Instructions',
  component: GlyphAgentInstructions,
  parameters: { paneWidth: '1000' },
  args: {
    openSource: fn(),
    sources: [
      { id: 'root', kind: 'agents_md', label: 'AGENTS.md', path: 'AGENTS.md', scope: '.', status: 'active' },
      {
        id: 'source',
        kind: 'agents_md',
        label: 'AGENTS.md',
        path: 'src/AGENTS.md',
        scope: 'src',
        status: 'active',
      },
      {
        id: 'docs',
        kind: 'agents_md',
        label: 'AGENTS.md',
        path: 'docs/AGENTS.md',
        scope: 'docs',
        status: 'error',
        message: 'File exceeds the configured instruction read limit.',
      },
    ],
  },
} satisfies Meta<typeof GlyphAgentInstructions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Catalog: Story = {};
export const Filtered: Story = { args: { query: 'src/' } };
export const Empty: Story = { args: { sources: [] } };
export const NoMatches: Story = { args: { query: 'missing' } };
