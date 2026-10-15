import { describe, expect, it, vi } from 'vitest';
import { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphService } from '#src/application/GlyphService.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatBackend } from '#src/chat/ChatBackend.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { GlyphWorkbenchCommandType as Command } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';

const usage = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 1, totalTokens: 5 };
type SendOptions = Parameters<ChatProvider['send']>[1];

async function fixture(send: (options: SendOptions, interactions: DesktopInteractionBroker) => Promise<void>) {
  const events: GlyphHostEvent[] = [];
  const saved = new Map<string, ChatSessionRecord>();
  let runtime: ProviderDesktopRuntime;
  const interactions = new DesktopInteractionBroker(event => runtime.publish(event));
  const account = {
    provider: 'fixture',
    id: 'account',
    label: 'Fixture account',
    detail: 'Fixture',
    connected: true,
    inferenceAccess: true,
  };
  const backend: ChatBackend = {
    presentation: {
      name: 'Fixture',
      welcome: '',
      usageDescription: '',
      accountsHeading: '',
      addAccountLabel: '',
      activeAccessLabel: '',
    },
    accounts: [account],
    initialize: async () => {},
    dispose: async () => {},
    signIn: async () => account,
    acknowledgeNotice: async () => {},
    logout: async () => true,
    redact: text => text.replaceAll('secret', '[REDACTED]'),
    listModels: async () => [{ slug: 'model', name: 'Model' }],
    createProvider: () => ({
      model: 'model',
      recordContext: () => {},
      exportState: () => ({ provider: 'fixture', version: 1, data: null }),
      restoreState: () => {},
      reset: () => {},
      send: async (_request, options) => {
        await send(options, interactions);
        return { usage, responseId: 'response' };
      },
    }),
  };
  const sessions = new ChatSessionManager(
    {
      initialize: async () => {},
      load: async () => [...saved.values()],
      save: async record => {
        saved.set(record.id, structuredClone(record));
      },
      dispose: async () => {},
    },
    {
      id: 'project',
      mutationIdentity: 'project',
      kind: ProjectContextKind.FOLDER,
      name: 'project',
      authority: 'file',
      roots: [{ name: 'project', path: '/project' }],
    },
  );
  const glyph = new GlyphService(
    backend,
    new NullLogger(),
    { traceEnabled: false },
    undefined,
    undefined,
    undefined,
    sessions,
  );
  await glyph.initialize();
  const shells = { close: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  runtime = new ProviderDesktopRuntime({
    glyph,
    interactions,
    shellSessions: shells,
    emit: event => events.push(event),
    ownerWindowId: 'owner',
  });
  await runtime.handle({ type: Command.CREATE_CHAT, accountProvider: 'fixture', accountId: 'account', model: 'model' });
  const chatId = (await runtime.snapshot()).chats[0]!.id;
  return { runtime, chatId, saved, events, glyph, shells };
}

describe(ProviderDesktopRuntime, () => {
  it('cancels an active provider turn and terminates background shells during trust-boundary disposal', async () => {
    const harness = await fixture(async options => {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    await harness.runtime.handle({
      type: Command.SEND,
      chatId: harness.chatId,
      runId: 'active',
      text: 'Continue',
      attachments: [],
    });
    await harness.runtime.dispose();
    expect(harness.shells.dispose).toHaveBeenCalledOnce();
    expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
  });

  it('drains an admitted proposal decision before disposing its chat storage', async () => {
    const harness = await fixture(async () => {});
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const disposed = vi.spyOn(harness.glyph, 'dispose');
    const checkpoint = vi.spyOn(harness.glyph, 'renameChat');
    const decisions = harness.runtime as unknown as { decideProposal(): Promise<void> };
    vi.spyOn(decisions, 'decideProposal').mockImplementation(async () => {
      await gate;
      await harness.glyph.renameChat(harness.chatId, 'Decision checkpoint');
    });
    const decision = harness.runtime.handle({
      type: Command.ACCEPT_PROPOSAL_ITEM,
      chatId: harness.chatId,
      proposalId: 'proposal',
      itemId: 'item',
    });
    const stopping = harness.runtime.dispose();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(disposed).not.toHaveBeenCalled();
    } finally {
      finish();
      await decision;
      await stopping;
    }
    expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(disposed.mock.invocationCallOrder[0]!);
  });

  it('streams a real application turn, persists its transcript, and includes reasoning, tools, and usage in recovery state', async () => {
    const harness = await fixture(async options => {
      options.onText('Answer');
      options.onReasoningSummary?.('Summary');
      options.onToolActivity?.({
        phase: ToolActivityPhase.COMPLETED,
        callId: 'tool',
        name: 'read',
        arguments: '{}',
        output: 'file',
      });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Question',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect(harness.saved.get(harness.chatId)?.transcript).toMatchObject([
        { userText: 'Question', assistantText: 'Answer', reasoningSummary: 'Summary' },
      ]);
      expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
        text: 'Answer',
        reasoning: 'Summary',
        tools: [{ id: 'tool' }],
      });
      expect((await harness.runtime.snapshot()).usageByChat?.[harness.chatId]).toEqual(usage);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps a model question recoverable until the matching answer resumes the same run', async () => {
    const harness = await fixture(async (options, interactions) => {
      await interactions.present(
        {
          questions: [
            {
              id: 'choice',
              prompt: 'Which?',
              allowMultiple: false,
              options: [
                { id: 'one', label: 'One' },
                { id: 'two', label: 'Two' },
              ],
            },
          ],
        },
        options.signal,
      );
      options.onText('Answered');
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Ask me',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_QUESTION),
      );
      const question = (await harness.runtime.snapshot()).runs[0]!.question!;
      await harness.runtime.handle({
        type: Command.ANSWER_QUESTION,
        chatId: harness.chatId,
        runId: 'run',
        questionId: question.id,
        answer: { answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['one'] }] },
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect((await harness.runtime.snapshot()).runs[0]?.question).toBeUndefined();
      expect(harness.events.some(event => event.type === GlyphHostEventType.QUESTION)).toBe(true);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('prevents competing runs in one chat and cancels waiting work when the owning window disconnects', async () => {
    const harness = await fixture(async (options, interactions) => {
      await interactions.presentShellPermission({ command: 'true', workingDirectory: '/project' }, options.signal);
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Wait',
        attachments: [],
      });
      await expect(
        harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'other',
          text: 'Conflict',
          attachments: [],
        }),
      ).rejects.toThrow('active run');
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL),
      );
      await harness.runtime.connectionLost('peer');
      expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
      await harness.runtime.connectionLost('owner');
      expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({ status: GlyphRunStatus.CANCELLED });
      expect((await harness.runtime.snapshot()).runs[0]?.approval).toBeUndefined();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('rejects unavailable accounts and models before creating a persistent chat', async () => {
    const harness = await fixture(async () => {});
    try {
      await expect(
        harness.runtime.handle({
          type: Command.CREATE_CHAT,
          accountProvider: 'fixture',
          accountId: 'another',
          model: 'model',
        }),
      ).rejects.toThrow('Connect an account');
      await expect(
        harness.runtime.handle({
          type: Command.CREATE_CHAT,
          accountProvider: 'fixture',
          accountId: 'account',
          model: 'missing',
        }),
      ).rejects.toThrow('unavailable');
      expect(harness.saved.size).toBe(1);
    } finally {
      await harness.runtime.dispose();
    }
  });
});
