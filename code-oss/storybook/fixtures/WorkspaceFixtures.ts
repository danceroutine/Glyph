import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';
import type { GlyphTodoItem } from '#src/desktop/protocol/events/GlyphTodoItem.js';
import type { GlyphPlanViewState, GlyphPlanViewActions } from '#src/desktop/workbench/GlyphPlanView.js';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { fixtureCreatedAt } from './MessageFixtures.ts';
export function selectionFixture(overrides: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment {
  return {
    uri: 'file:///preview/src/greeting.ts',
    path: 'src/greeting.ts',
    text: 'export const greet = (name: string) => `Hello, ${name}!`;',
    id: 'preview-selection',
    kind: GlyphContextAttachmentKind.SELECTION,
    contentRevision: 'preview-hash',
    sourceRevision: 'preview:3',
    token: {
      workspaceGeneration: 'preview',
      resource: 'file:///preview/src/greeting.ts',
      incarnation: 'preview',
      version: 3,
    },
    range: {
      start: {
        line: 11,
        column: 1,
      },
      end: {
        line: 14,
        column: 2,
      },
    },
    ...structuredClone(overrides),
  };
}
export function workbenchStateFixture(overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState {
  return {
    accounts: [],
    models: [],
    chats: [],
    runs: [],
    proposals: [],
    ownerWindowId: 'storybook',
    readOnly: false,
    sequence: 0,
    usage: {},
    status: GlyphWorkbenchStatus.READY,
    transcript: [],
    ...structuredClone(overrides),
  };
}
export function chatFixture(overrides: Partial<GlyphChatSummary> = {}): GlyphChatSummary {
  return {
    id: 'settings',
    title: 'Review the settings migration',
    accountProvider: 'fixture',
    accountId: 'personal',
    modelSlug: 'balanced',
    updatedAt: fixtureCreatedAt,
    turnCount: 4,
    ...structuredClone(overrides),
  };
}

export const todoItems: readonly GlyphTodoItem[] = [
  { id: 'inspect', text: 'Inspect the current implementation', status: 'completed' },
  { id: 'implement', text: 'Implement the todo card', status: 'in_progress' },
  { id: 'verify', text: 'Verify persistence and chat isolation', status: 'pending' },
];

export const planView: GlyphPlanViewState = {
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
};

export const planActions: GlyphPlanViewActions = {
  update: async () => {},
  build: async () => {},
  newAgent: async () => {},
  openChat: async () => {},
  openLink: async () => {},
};

export const pendingProposals: readonly GlyphProposalSummary[] = [
  {
    id: 'proposal',
    chatId: 'chat',
    createdAt: fixtureCreatedAt,
    files: [
      {
        id: 'runtime',
        path: 'src/desktop/host/ProviderDesktopRuntime.ts',
        proposedUri: 'glyph-proposal:/proposal/runtime',
        pendingItemIds: ['one'],
        applicability: GlyphProposalApplicability.READY,
        textOnly: true,
        additions: 2,
        deletions: 1,
      },
      {
        id: 'decision',
        path: 'code-oss/ui/useGlyphDecision.ts',
        proposedUri: 'glyph-proposal:/proposal/decision',
        pendingItemIds: ['two'],
        applicability: GlyphProposalApplicability.READY,
        textOnly: true,
        additions: 1,
        deletions: 2,
      },
    ],
  },
];

export const editorChanges = [
  { before: '  send(message);', after: '  pendingMessages.push(message);' },
  { before: '  return undefined;', after: '  return pendingMessages.shift();' },
];

export function navigationStateFixture(): GlyphWorkbenchState {
  return workbenchStateFixture({
    accounts: [
      {
        provider: 'fixture',
        id: 'personal',
        label: 'developer@example.invalid',
        connected: true,
        inferenceAccess: true,
      },
    ],
    models: [
      { slug: 'balanced', name: 'Balanced' },
      { slug: 'deep', name: 'Deep reasoning' },
    ],
    selectedAccount: { provider: 'fixture', id: 'personal' },
    selectedModel: 'balanced',
    chats: [
      chatFixture(),
      {
        ...chatFixture(),
        id: 'rendering',
        title: 'Investigate rendering performance',
        updatedAt: '2026-10-18T14:30:00Z',
      },
    ],
  });
}

export const autoModel = { slug: 'auto', name: 'Auto' };
