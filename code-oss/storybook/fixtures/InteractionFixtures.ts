import type { GlyphQuestionRequest } from '#src/desktop/protocol/events/GlyphQuestionRequest.js';
import type { GlyphApprovalRequest } from '#src/desktop/protocol/events/GlyphApprovalRequest.js';
import { GlyphModeSwapStatus, type GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { fixtureCreatedAt } from './MessageFixtures.ts';

export const languageQuestion: GlyphQuestionRequest & {
  readonly questions: NonNullable<GlyphQuestionRequest['questions']>;
} = {
  id: 'question',
  title: 'Questions',
  prompt: 'Choose a language.',
  questions: [
    {
      id: 'language',
      prompt: 'What is your favorite programming language?',
      allowMultiple: false,
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'rust', label: 'Rust' },
        { id: 'python', label: 'Python' },
      ],
    },
    {
      id: 'priorities',
      prompt: 'Which qualities matter most?',
      allowMultiple: true,
      options: [
        { id: 'clarity', label: 'Clarity' },
        { id: 'speed', label: 'Speed' },
      ],
    },
  ],
};

export const preferencesQuestion: GlyphQuestionRequest & {
  readonly questions: NonNullable<GlyphQuestionRequest['questions']>;
} = {
  id: 'preferences',
  title: 'Questions',
  prompt: 'A few preferences.',
  questions: [
    {
      id: 'theme',
      prompt: 'Which editor theme do you usually use?',
      allowMultiple: false,
      options: [
        { id: 'dark', label: 'Dark (Recommended)' },
        { id: 'light', label: 'Light' },
        { id: 'contrast', label: 'High contrast' },
        { id: 'system', label: 'Follow the system setting' },
      ],
    },
    {
      id: 'runners',
      prompt: 'Which test runners have you used? Pick as many as apply.',
      allowMultiple: true,
      options: [
        { id: 'vitest', label: 'Vitest' },
        { id: 'jest', label: 'Jest' },
        { id: 'node', label: 'node:test' },
        { id: 'playwright', label: 'Playwright' },
      ],
    },
    {
      id: 'drink',
      prompt: 'Coffee or tea?',
      allowMultiple: false,
      options: [
        { id: 'coffee', label: 'Coffee' },
        { id: 'tea', label: 'Tea' },
      ],
    },
  ],
};
export function approvalFixture(overrides: Partial<GlyphApprovalRequest> = {}): GlyphApprovalRequest {
  return {
    id: 'approval',
    title: 'Allow shell command?',
    detail: 'pnpm test',
    command: 'pnpm test',
    workingDirectory: '/workspace/glyph',
    sandboxed: true,
    canRemember: true,
    ...structuredClone(overrides),
  };
}
export function modeSwapFixture(
  overrides: Partial<GlyphModeSwap> = {},
  now = Date.parse(fixtureCreatedAt),
): GlyphModeSwap {
  const target = overrides.target ?? AgentModeID.AGENT;
  return {
    id: 'mode-switch',
    source: target === AgentModeID.AGENT ? AgentModeID.PLAN : AgentModeID.AGENT,
    target,
    status: GlyphModeSwapStatus.PENDING,
    description:
      target === AgentModeID.AGENT
        ? 'The plan is ready. Switch to Agent Mode to implement the changes and run the verification steps.'
        : 'Switch to Plan Mode to inspect the context and outline the changes before implementation.',
    autoApprove: false,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15000).toISOString(),
    ...structuredClone(overrides),
  };
}

export const followUpQuestion: typeof preferencesQuestion = {
  ...preferencesQuestion,
  id: 'follow-up',
  questions: [
    {
      id: 'follow-up',
      prompt: 'One follow-up: should I include examples?',
      allowMultiple: false,
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
  ],
};
