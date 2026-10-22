import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';

/** Fixed dates keep static stories reproducible. Interactive turns pass their creation time explicitly. */
export const fixtureCreatedAt = '2026-10-19T14:30:00Z';
export function usageFixture(overrides: Partial<GlyphUsage> = {}): GlyphUsage {
  return {
    inputTokens: 12400,
    cachedInputTokens: 8000,
    outputTokens: 650,
    reasoningTokens: 200,
    totalTokens: 13050,
    ...overrides,
  };
}

type MessageOverrides = Partial<Omit<GlyphTranscriptEntry, 'role'>>;
/** Complete metadata by default; a different ID also becomes the checkpoint unless explicitly overridden. */
export function agentMessageFixture(overrides: MessageOverrides = {}): GlyphTranscriptEntry {
  const id = overrides.id ?? 'run';
  return {
    id,
    role: GlyphTranscriptRole.ASSISTANT,
    checkpointTurnId: id,
    createdAt: fixtureCreatedAt,
    text: 'The queue preserves message order and the original attachments. See [GlyphComposerState.ts](src/desktop/workbench/GlyphComposerState.ts).',
    usage: usageFixture(),
    ...structuredClone(overrides),
  };
}
export function userMessageFixture(overrides: MessageOverrides = {}): GlyphTranscriptEntry {
  const checkpointTurnId = overrides.checkpointTurnId ?? 'run';
  return {
    id: `${checkpointTurnId}:user`,
    role: GlyphTranscriptRole.USER,
    ...(overrides.steering === true ? {} : { checkpointTurnId }),
    createdAt: fixtureCreatedAt,
    text: 'How does the Glyph sidebar render?',
    ...structuredClone(overrides),
  };
}
export function diagnosticMessageFixture(overrides: MessageOverrides = {}): GlyphTranscriptEntry {
  return {
    id: 'diagnostic-1',
    role: GlyphTranscriptRole.DIAGNOSTIC,
    text: 'Preview conversation · no agent connected',
    ...structuredClone(overrides),
  };
}
export function conversationFixture(): readonly GlyphTranscriptEntry[] {
  return [
    userMessageFixture({ id: 'user-1', checkpointTurnId: 'assistant-1' }),
    agentMessageFixture({
      id: 'assistant-1',
      text: 'The native pane mounts the Preact view and passes in state and callbacks. The transcript and composer render inside that view.\n\nYou can edit these components in Storybook and check the integration in Code OSS afterward.',
    }),
    diagnosticMessageFixture(),
  ];
}
export function longConversationFixture(count = 40): readonly GlyphTranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const checkpointTurnId = `long-${index % 2 === 0 ? index + 1 : index}`;
    const overrides = {
      id: `long-${index}`,
      checkpointTurnId,
      text: `Message ${index + 1}\n${'Long messages should wrap inside the pane and leave the transcript scrollable. '.repeat(6)}`,
    };
    return index % 2 === 0 ? userMessageFixture(overrides) : agentMessageFixture(overrides);
  });
}

export const messageActionsConversation: readonly GlyphTranscriptEntry[] = [
  userMessageFixture({
    id: 'first:user',
    checkpointTurnId: 'first',
    createdAt: '2026-10-18T14:29:50Z',
    text: 'Good, now undo both changes',
  }),
  agentMessageFixture({
    id: 'first',
    checkpointTurnId: 'first',
    text: 'Both changes are reverted in [ProviderDesktopRuntime.ts](src/desktop/host/ProviderDesktopRuntime.ts) and `useGlyphDecision.ts`.',
    createdAt: '2026-10-18T14:30:00Z',
  }),
  userMessageFixture({
    id: 'second:user',
    createdAt: '2026-10-18T14:31:50Z',
    checkpointTurnId: 'second',
    text: "Make a sample plan, doesn't have to be of anything specific, just need to check the UI, add some todos in the plan",
  }),
  agentMessageFixture({
    id: 'second',
    checkpointTurnId: 'second',
    text: 'Here is a sample plan for the message queue.',
    createdAt: '2026-10-18T14:32:00Z',
  }),
];
