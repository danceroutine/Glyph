import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphPlan } from './GlyphPlan.wired.tsx';
const meta = {
  title: 'Glyph/Editor/Plan',
  component: WiredGlyphPlan,
  args: {
    state: {
      disabled: false,
      modelLabel: 'Auto',
      plan: {
        id: 'plan',
        revision: 1,
        title: 'Queue composer messages',
        summary: 'Preserve prompts until the active run finishes.',
        markdown: `# Sample plan: queue composer messages during a run

This is a sample plan for UI testing. The file paths are real, but nobody has scoped this work.

## Goal

Let the user keep typing and submitting while the agent is mid-run. Submitted messages are held in a queue and sent one at a time, in order, once the active run finishes.

## Flow

\`\`\`mermaid
flowchart LR
Finished[Run finishes] --> Next[Send next queued message]
Next --> Active{Run active?}
Composer -->|submit| Active
Active -->|yes| Queue[Add to queue]
Active -->|no| Send[Send immediately]
Queue --> Finished
\`\`\`

## Changes

- State: add a queued list to the composer state in [GlyphComposerState.ts](src/desktop/workbench/GlyphComposerState.ts).
- Runtime: when a run completes, send the next queued message.
- UI: show queued messages above the composer, with a way to remove one.
- Tests: cover ordering and removal in composer state tests.

## Out of scope

- Editing a queued message after submitting it
- Persisting the queue across app restarts`,
        todos: [
          { id: 'state', text: 'Add a queued-messages list to GlyphComposerState', completed: false },
          {
            id: 'runtime',
            text: 'Send the next queued message when a run completes in ProviderDesktopRuntime',
            completed: false,
          },
          { id: 'ui', text: 'Show queued messages above the composer with a remove action', completed: false },
          { id: 'story', text: 'Add a GlyphComposer story with queued messages', completed: false },
          { id: 'test', text: 'Cover queue ordering and removal in GlyphComposerState tests', completed: false },
        ],
        agents: [{ chatId: 'author', role: 'Author' }],
      },
      agents: [{ chatId: 'author', title: 'Queue design', role: 'Author' }],
    },
    actions: {
      update: async () => {},
      build: async () => {},
      newAgent: async () => {},
      openChat: async () => {},
      openLink: async () => {},
    },
  },
  globals: { paneWidth: '1000' },
  parameters: { layout: 'fullscreen' },
  decorators: [
    Story => (
      <div style={{ height: 'calc(100vh - 34px)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WiredGlyphPlan>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Document: Story = {};
export const ReadOnly: Story = { args: { state: { ...meta.args.state, disabled: true } } };

export const Narrow: Story = { globals: { paneWidth: '360' } };
