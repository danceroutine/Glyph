import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { ChatSteeringQueue } from '#src/chat/ChatSteeringQueue.js';
import { DiagnosticSeverity } from '#src/chat/DiagnosticSeverity.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { ChatHistoryError } from '#src/chat/sessions/ChatHistoryError.js';
import { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ChatSessionRecord, ChatTranscriptTurn } from '#src/chat/sessions/ChatSessionRecord.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';

function harness({
  send = async () => ({ responseId: 'resp', usage: null }),
  transcript = [],
  logger = new NullLogger(),
  traceEnabled = false,
}: {
  send?: ChatProvider['send'];
  transcript?: ChatTranscriptTurn[];
  logger?: Logger;
  traceEnabled?: boolean;
} = {}) {
  let providerState: ChatProviderState = { provider: 'fake', version: 1, data: { history: [] } };
  const provider: ChatProvider = {
    model: 'test-model',
    recordContext: vi.fn(events => {
      providerState = { ...providerState, data: { history: events } };
    }),
    exportState: vi.fn(() => providerState),
    restoreState: vi.fn(state => {
      providerState = state;
    }),
    reset: vi.fn(() => {
      providerState = { provider: 'fake', version: 1, data: { history: ['reset'] } };
    }),
    send: vi.fn(send),
  };
  let record: ChatSessionRecord = {
    schemaVersion: 3,
    id: 'chat',
    title: 'Chat',
    titleOrigin: 'placeholder',
    projectContextId: 'project',
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'test-model',
    modelName: 'Test Model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    providerState,
    transcript,
  };
  const checkpoint = vi.fn(async (state: ChatProviderState, checkpointTurn?: ChatTranscriptTurn) => {
    record = {
      ...record,
      providerState: state,
      transcript: checkpointTurn ? [...record.transcript, checkpointTurn] : record.transcript,
    };
  });
  const session = new ChatSession(
    () => record,
    new ChatConversation(
      provider,
      logger,
      value => value,
      () => {},
      traceEnabled,
    ),
    checkpoint,
  );
  return { session, provider, checkpoint, record: () => record };
}

function turn(overrides: Partial<ChatTranscriptTurn> = {}): ChatTranscriptTurn {
  return {
    userText: 'hello',
    attachmentPaths: [],
    assistantText: 'hi',
    reasoningSummary: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe(ChatSession, () => {
  it('exposes the conversation model, trace setting, and saved usage', () => {
    const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 };
    const { session } = harness({ transcript: [turn({ usage }), turn()] });

    expect(session.id).toBe('chat');
    expect(session.model).toBe('test-model');
    expect(session.isTraceEnabled).toBe(false);
    session.setTraceEnabled(true);
    expect(session.isTraceEnabled).toBe(true);
    expect(session.usage).toEqual({ ...usage, unreportedTurns: 1 });
    expect(session.summary).toMatchObject({ id: 'chat', mode: AgentModeID.AGENT, turnCount: 2 });
  });

  describe(ChatSession.prototype.send, () => {
    it('persists plan build and progress metadata with the completed turn', async () => {
      const { session, record } = harness();
      const planBuild = { planId: 'plan', revision: 1, title: 'Plan', sourceChatId: 'source', todos: [] };
      const planProgress = { planId: 'plan', title: 'Plan', completed: 0, total: 1 };
      await session.send(
        { text: 'Continue', attachments: [], planBuild, planProgress },
        { push() {} },
        new AbortController().signal,
      );
      expect(record().transcript[0]!.options).toMatchObject({ planBuild, planProgress });
    });
    it('records text, reasoning, diagnostics, and bounded tool summaries in the saved turn', async () => {
      const logger = new NullLogger();
      vi.spyOn(logger, 'trace').mockImplementation(() => {
        throw new Error('trace unavailable');
      });
      const { session, record } = harness({
        logger,
        traceEnabled: true,
        send: async (_request, options) => {
          options.onText('Running ');
          options.onToolActivity?.({
            phase: ToolActivityPhase.STARTED,
            namespace: 'shell',
            name: 'execute_shell',
            callId: 'shell-call',
            arguments: JSON.stringify({ command: 'ls' }),
          });
          options.onText('commands.');
          options.onReasoningSummary?.('Listing files.');
          options.onToolActivity?.({
            phase: ToolActivityPhase.COMPLETED,
            namespace: 'shell',
            name: 'execute_shell',
            callId: 'shell-call',
            arguments: JSON.stringify({ command: 'ls' }),
            output: JSON.stringify({ output: 'file.txt', exit_code: 0 }),
          });
          options.onToolActivity?.({
            phase: ToolActivityPhase.COMPLETED,
            namespace: 'project',
            name: 'read_project_file',
            callId: 'read-call',
            arguments: 'x'.repeat(16_001),
          });
          return { responseId: 'resp', usage: null };
        },
      });
      const parts: ChatResponsePart[] = [];

      await session.send(
        'hello',
        {
          push: part => {
            parts.push(part);
          },
        },
        new AbortController().signal,
      );

      expect(parts.map(part => part.type)).toEqual([
        ChatResponsePartType.TEXT,
        ChatResponsePartType.TOOL,
        ChatResponsePartType.TEXT,
        ChatResponsePartType.REASONING_SUMMARY,
        ChatResponsePartType.TOOL,
        ChatResponsePartType.TOOL,
        ChatResponsePartType.DIAGNOSTIC,
      ]);
      expect(parts.at(-1)).toEqual({
        type: ChatResponsePartType.DIAGNOSTIC,
        severity: DiagnosticSeverity.ERROR,
        message: 'Trace log write failed: trace unavailable',
      });
      const saved = record().transcript[0]!;
      expect(saved).toMatchObject({
        userText: 'hello',
        assistantText: 'Running commands.',
        reasoningSummary: 'Listing files.',
      });
      expect(saved).not.toHaveProperty('usage');
      expect(saved).not.toHaveProperty('attachments');
      expect(saved.tools).toEqual([
        {
          callId: 'shell-call',
          name: 'execute_shell',
          phase: ToolActivityPhase.COMPLETED,
          arguments: JSON.stringify({ command: 'ls' }),
          output: JSON.stringify({ output: 'file.txt', exit_code: 0 }),
          textOffset: 8,
          shell: { command: 'ls', output: 'file.txt', background: false, exitCode: 0 },
        },
        {
          callId: 'read-call',
          name: 'read_project_file',
          phase: ToolActivityPhase.COMPLETED,
          arguments: `${'x'.repeat(16_000)}\n… (truncated)`,
          textOffset: 17,
        },
      ]);
    });

    it('saves request options, interaction results, steering, attachments, and usage with the turn', async () => {
      const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 };
      const { session, record, provider } = harness({
        send: async (_request, options) => {
          options.takeSteering?.(false);
          options.onText('Done.');
          return {
            responseId: 'resp',
            usage,
            context: {
              schema: 'glyph.turn-context.v1',
              turnId: 'turn-1',
              sources: [],
              activations: [],
              candidates: [],
            },
          };
        },
      });
      const steering = new ChatSteeringQueue();
      const message = {
        id: 'steer',
        text: 'Faster.',
        createdAt: '2026-01-01T00:00:00.000Z',
        options: {},
        attachments: [],
      };
      steering.add({ text: 'Faster.', attachments: [] }, message);
      const attachment = { path: 'a.ts', revision: 'r1', text: 'a', byteOrderMark: false, byteLength: 1 };
      const annotation = {
        id: 'note',
        order: 1,
        kind: 'chat' as const,
        sourceId: 'source',
        revision: 'r1',
        label: '',
        quote: 'a',
        from: 0,
        to: 1,
        comment: 'Look.',
      };
      const questionResponses = [{ id: 'q', answers: [{ question: 'Which?', answer: 'This.' }] }];
      const modeSwaps = [
        {
          id: 'swap',
          source: AgentModeID.AGENT,
          target: AgentModeID.PLAN,
          description: 'Plan first.',
          status: GlyphModeSwapStatus.APPROVED,
          expiresAt: '2026-01-01T00:00:00.000Z',
          autoApprove: false,
        },
      ];

      const result = await session.send(
        {
          text: 'Build it.',
          attachments: [attachment],
          attachmentSpans: [{ from: 0, to: 1 }],
          turnId: 'turn-1',
          agentReviewId: '00000000-0000-4000-8000-000000000000',
          mode: AgentModeID.PLAN,
          annotations: [annotation],
          manualRuleIds: ['rule-id'],
        },
        { push: () => {} },
        new AbortController().signal,
        () => questionResponses,
        () => modeSwaps,
        steering,
      );

      expect(result).toMatchObject({ responseId: 'resp', usage });
      expect(provider.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          takeSteering: steering.take,
          toolContext: { chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' } },
        }),
      );
      expect(record().transcript[0]).toMatchObject({
        questionResponses,
        modeSwaps,
        steering: [message],
        userText: 'Build it.',
        options: {
          attachmentSpans: [{ from: 0, to: 1 }],
          turnId: 'turn-1',
          agentReviewId: '00000000-0000-4000-8000-000000000000',
          mode: AgentModeID.PLAN,
          annotations: [annotation],
          manualRuleIds: ['rule-id'],
        },
        attachmentPaths: ['a.ts'],
        attachments: [attachment],
        context: { schema: 'glyph.turn-context.v1', turnId: 'turn-1' },
        assistantText: 'Done.',
        usage,
        tools: [],
      });
    });
  });

  describe(ChatSession.prototype.restoreCheckpoint, () => {
    it('rejects turns saved without checkpoints, addressing them by position', async () => {
      const { session } = harness({ transcript: [turn()] });

      await expect(session.restoreCheckpoint('chat:history:0')).rejects.toThrow(
        new ChatHistoryError('This message has no saved checkpoint.'),
      );
    });

    it('rejects checkpointed turns when history replacement is unavailable', async () => {
      const providerState = { provider: 'fake', version: 1, data: { history: [] } };
      const checkpoint = { providerState, plans: [], todos: [], mode: AgentModeID.AGENT };
      const { session } = harness({
        transcript: [turn({ options: { turnId: 'saved' }, checkpoints: { before: checkpoint, after: checkpoint } })],
      });

      await expect(session.restoreCheckpoint('saved')).rejects.toThrow('This message has no saved checkpoint.');
    });
  });

  describe(ChatSession.prototype.historyAt, () => {
    it('finds a turn by its saved ID', async () => {
      const saved = turn({ options: { turnId: 'saved' } });
      const { session } = harness({ transcript: [turn(), saved] });

      await expect(session.historyAt('saved')).resolves.toMatchObject({ index: 1, turn: saved });
      await expect(session.historyAt('chat:history:0')).resolves.toMatchObject({ index: 0 });
    });
  });

  describe(ChatSession.prototype.recordContext, () => {
    it('ignores an empty event list', async () => {
      const { session, checkpoint, provider } = harness();

      await session.recordContext([]);

      expect(checkpoint).not.toHaveBeenCalled();
      expect(provider.recordContext).not.toHaveBeenCalled();
    });
  });

  describe(ChatSession.prototype.reset, () => {
    it('restores the previous provider state when saving the reset fails', async () => {
      const { session, checkpoint, provider } = harness();
      const before = provider.exportState();
      checkpoint.mockRejectedValueOnce(new Error('disk full'));

      await expect(session.reset()).rejects.toThrow('disk full');

      expect(provider.reset).toHaveBeenCalledOnce();
      expect(provider.restoreState).toHaveBeenLastCalledWith(before);
      expect(provider.exportState()).toEqual(before);
    });
  });
});
