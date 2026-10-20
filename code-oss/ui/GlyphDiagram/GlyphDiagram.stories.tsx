import { fn } from 'storybook/test';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import { WiredGlyphDiagram } from './GlyphDiagram.wired.tsx';

const meta = {
  title: 'Glyph/Shared/Diagrams',
  component: WiredGlyphDiagram,
  args: {
    source: 'flowchart LR\n  Composer --> Queue\n  Queue --> Send',
    openLink: fn().mockName('GlyphDiagram.openLink'),
  },
  decorators: agentMessageDecorators,
  globals: { paneWidth: '600' },
} satisfies Meta<typeof WiredGlyphDiagram>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Flowchart: Story = {
  args: {
    source: [
      'flowchart LR',
      '  Composer --> Active{Run active?}',
      '  Active -->|yes| Queue[Add to queue]',
      '  Active -->|no| Send[Send immediately]',
      '  Queue --> Send',
    ].join('\n'),
  },
};

export const FlowchartWithLinks: Story = {
  args: {
    source: [
      'flowchart TD',
      '  Plan[Read the plan] --> Source[Open the composer state]',
      '  Source --> Docs[Read the Mermaid docs]',
      '  click Source "src/desktop/workbench/GlyphComposerState.ts"',
      '  click Docs "https://mermaid.js.org/syntax/flowchart.html"',
    ].join('\n'),
  },
};

export const Sequence: Story = {
  args: {
    source: [
      'sequenceDiagram',
      '  participant Composer',
      '  participant Host',
      '  participant Agent',
      '  Composer->>Host: Submit message',
      '  Host->>Agent: Start turn',
      '  Agent-->>Host: Stream reply',
      '  Host-->>Composer: Render transcript',
    ].join('\n'),
  },
};

export const State: Story = {
  args: {
    source: [
      'stateDiagram-v2',
      '  [*] --> Idle',
      '  Idle --> Running: Submit',
      '  Running --> Idle: Complete',
      '  Running --> Cancelled: Cancel',
      '  Cancelled --> [*]',
    ].join('\n'),
  },
};

export const Class: Story = {
  args: {
    source: [
      'classDiagram',
      '  class GlyphComposerState {',
      '    +snapshot',
      '    +setDraft(text)',
      '  }',
      '  class GlyphQueue {',
      '    +enqueue(message)',
      '  }',
      '  GlyphComposerState --> GlyphQueue',
    ].join('\n'),
  },
};

export const EntityRelationship: Story = {
  args: {
    source: [
      'erDiagram',
      '  CHAT ||--o{ TURN : contains',
      '  TURN ||--o{ ATTACHMENT : carries',
      '  CHAT {',
      '    string id',
      '    string title',
      '  }',
    ].join('\n'),
  },
};

export const XYChart: Story = {
  args: {
    source: [
      'xychart-beta',
      '  title "Turn latency"',
      '  x-axis [Mon, Tue, Wed, Thu, Fri]',
      '  y-axis "Seconds" 0 --> 12',
      '  bar [4, 6, 5, 9, 7]',
      '  line [4, 6, 5, 9, 7]',
    ].join('\n'),
  },
};

export const GanttFallback: Story = {
  args: {
    source: [
      'gantt',
      '  dateFormat YYYY-MM-DD',
      '  section Build',
      '  Implement :a1, 2026-10-01, 3d',
      '  Review :after a1, 2d',
      '  section Ship',
      '  Release :2026-10-07, 1d',
    ].join('\n'),
  },
};

export const PieFallback: Story = {
  args: {
    source: ['pie title Tool calls', '  "Read" : 42', '  "Edit" : 18', '  "Shell" : 9'].join('\n'),
  },
};

export const UnrenderableSource: Story = {
  args: {
    source: '---\nconfig:\n  theme: forest\n---\nflowchart LR\n  A --> B',
  },
};
