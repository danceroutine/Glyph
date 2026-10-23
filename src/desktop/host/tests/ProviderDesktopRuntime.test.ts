import type { ShellWakeEvent } from '#src/shell/ShellWakeEvent.js';
import type { ChatRequest } from '#src/chat/ChatRequest.js';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import type { GlyphRuntimeCommand } from '#src/desktop/host/GlyphDesktopWorkspaceRuntime.js';
import { toGlyphProposalFilePreview } from '#src/desktop/host/toGlyphProposalFilePreview.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { DiagnosticSeverity } from '#src/chat/DiagnosticSeverity.js';
import { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ContextAttachmentSource } from '#src/context/attachments/ContextAttachmentSource.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { FileEditPlan, type FileEditPlanRecord } from '#src/editing/proposals/FileEditPlan.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import { ProposalReviewChangeType } from '#src/editing/reviews/ProposalReviewManager.js';
import {
  AgentReviewScope,
  AgentReviewStatus,
  type AgentReview,
  type AgentReviewInput,
  type AgentReviewModel,
} from '#src/reviewing/AgentReview.js';
import type { AgentReviewService } from '#src/reviewing/AgentReviewService.js';
import { GlyphDesktopHost } from '#src/desktop/host/GlyphDesktopHost.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphService } from '#src/application/GlyphService.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';
import type { ChatBackend } from '#src/chat/ChatBackend.js';
import type { ChatSessionStore } from '#src/chat/sessions/ChatSessionStore.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import { OpenAIModelCatalog } from '#src/providers/openai/OpenAIModelCatalog.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { GlyphWorkbenchCommandType as Command } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphWorkbenchCommand } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { toSummary } from '#src/chat/sessions/ChatSession.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { Usage } from '#src/chat/Usage.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
import { GoalStatus } from '#src/goals/GoalStatus.js';

const usage = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 1, totalTokens: 5 };
type SendOptions = Parameters<ChatProvider['send']>[1];

async function fixture(
  send: (options: SendOptions, interactions: DesktopInteractionBroker) => Promise<void | Usage | null>,
  ownerWindowId = 'owner',
  reviews?: ProposalReviewManager,
  extras: { readonly agentReviews?: AgentReviewService; readonly records?: readonly ChatSessionRecord[] } = {},
) {
  const events: GlyphHostEvent[] = [];
  const saved = new Map<string, ChatSessionRecord>((extras.records ?? []).map(record => [record.id, record]));
  const recorded: ChatContextEvent[][] = [];
  let runtime: ProviderDesktopRuntime;
  const interactions = new DesktopInteractionBroker(event => {
    runtime.publish(event);
  });
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
    createProvider: () => {
      const context: ChatContextEvent[] = [];
      const states = new Map<string, ChatContextEvent[]>();
      recorded.push(context);
      return {
        model: 'model',
        recordContext: incoming => {
          for (const event of incoming) if (!context.some(previous => previous.id === event.id)) context.push(event);
        },
        exportState: () => {
          const data = structuredClone(context);
          states.set(JSON.stringify(data), data);
          return { provider: 'fixture', version: 1, data };
        },
        restoreState: state => {
          context.splice(0, context.length, ...(states.get(JSON.stringify(state.data)) ?? []));
        },
        reset: () => {},
        send: async (_request, options) => {
          const reported = await send(options, interactions);
          return { usage: reported === undefined ? usage : reported, responseId: 'response' };
        },
      };
    },
  };
  const store: ChatSessionStore = {
    initialize: async () => {},
    load: async () => [...saved.values()],
    save: async record => {
      saved.set(record.id, structuredClone(record));
    },
    dispose: async () => {},
  };
  const sessions = new ChatSessionManager(store, {
    id: 'project',
    mutationIdentity: 'project',
    kind: ProjectContextKind.FOLDER,
    name: 'project',
    authority: 'file',
    roots: [{ name: 'project', path: '/project' }],
  });
  const glyph = new GlyphService(
    backend,
    new NullLogger(),
    { traceEnabled: false },
    reviews,
    undefined,
    undefined,
    sessions,
  );
  await glyph.initialize();
  const wakes: ShellWakeEvent[] = [];
  const wakeListeners = new Set<(wake: ShellWakeEvent) => void>();
  const shellListeners = new Set<() => void>();
  const shells = {
    allSessions: [] as ShellSessionSnapshot[],
    onDidWake: (listener: (wake: ShellWakeEvent) => void) => {
      wakeListeners.add(listener);
      return () => {
        wakeListeners.delete(listener);
      };
    },
    peekPendingWake: (accepts: (wake: ShellWakeEvent) => boolean) => wakes.find(value => accepts(value)),
    takePendingWake: (id?: string) => {
      const index = id === undefined ? 0 : wakes.findIndex(wake => wake.id === id);
      return index < 0 ? undefined : wakes.splice(index, 1)[0];
    },
    onDidChange: (listener: () => void) => {
      shellListeners.add(listener);
      return () => {
        shellListeners.delete(listener);
      };
    },
    writeInput: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  runtime = new ProviderDesktopRuntime({
    glyph,
    interactions,
    shellSessions: shells,
    emit: event => {
      events.push(event);
    },
    ownerWindowId,
    ...(extras.agentReviews ? { agentReviews: extras.agentReviews } : {}),
  });
  await runtime.handle({ type: Command.CREATE_CHAT, accountProvider: 'fixture', accountId: 'account', model: 'model' });
  const chatId = (await runtime.snapshot()).chats.find(
    chat => extras.records?.some(record => record.id === chat.id) !== true,
  )!.id;
  return {
    runtime,
    interactions,
    chatId,
    saved,
    events,
    glyph,
    shells,
    backend,
    store,
    recorded,
    wake: (wake: ShellWakeEvent) => {
      if (!wakes.some(value => value.id === wake.id)) wakes.push(wake);
      for (const listener of wakeListeners) listener(wake);
    },
    emitShells: () => {
      for (const listener of shellListeners) listener();
    },
  };
}

function reviewFixture() {
  const unexpectedMutation = async (): Promise<never> => {
    throw new Error('No file mutation is expected.');
  };
  const workspace: WorkspaceTextStore = {
    root: '/project',
    caseSensitive: true,
    mutationConsistency: WorkspaceMutationConsistency.ATOMIC_VERSIONED,
    normalizePath: path => path,
    canonicalPath: async path => `/project/${path}`,
    exists: async () => false,
    list: async () => ({ files: [], truncated: false }),
    read: unexpectedMutation,
    readOptional: async () => undefined,
    replace: unexpectedMutation,
    create: unexpectedMutation,
    rename: unexpectedMutation,
    delete: unexpectedMutation,
  };
  const store = { load: async () => [], save: vi.fn(async () => {}), clear: async () => {} };
  const reviews = new ProposalReviewManager(workspace, store);
  const compiler = new EditProposalService(workspace, new JsDiffTextDiffer(), {
    maxRawProposalBytes: 1048576,
    maxChangedBytes: 1048576,
    maxResultingBytesPerFile: 1048576,
    maxFiles: 64,
    maxTotalHunks: 256,
    maxHunksPerFile: 64,
    diffBudgetMs: 1000,
    maxActiveReviews: 8,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  });
  return {
    reviews,
    store,
    stage: async (
      chatId: string,
      withOrigin = true,
      origin: { readonly accountProvider?: string; readonly accountId?: string } = {},
      path = `${chatId}.txt`,
    ) => {
      const proposal = await compiler.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path,
            new_path: null,
            base_revision: null,
            content: 'proposed',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await reviews.stage(
        withOrigin
          ? proposal.withOrigin({ chatId, accountProvider: 'fixture', accountId: 'account', ...origin })
          : proposal,
      );
      return { proposalId: proposal.id, itemId: proposal.files[0]!.items[0]!.id };
    },
  };
}

describe(ProviderDesktopRuntime, () => {
  it('routes steering to its exact active run, persists it, and rejects a stale target without a competing send', async () => {
    const gate = deferredVoid();
    const entered = deferredVoid();
    let received: readonly ChatRequest[] = [];
    let sends = 0;
    const harness = await fixture(async options => {
      sends++;
      entered.resolve();
      await gate.promise;
      expect(options.signal.aborted).toBe(false);
      received = options.takeSteering!(false);
      options.onText('Continued');
      options.takeSteering!(true);
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Start',
        attachments: [],
      });
      await entered.promise;
      const command = {
        type: Command.STEER as const,
        chatId: harness.chatId,
        runId: 'run',
        messageId: 'steer',
        text: 'Keep going',
        attachments: [],
      };
      await expect(harness.runtime.handle({ ...command, runId: 'different' })).rejects.toThrow('no active response');
      await harness.runtime.handle(command);
      await harness.runtime.handle(command);
      expect((await harness.runtime.snapshot()).runs[0]?.steering).toHaveLength(1);
      gate.resolve();
      await vi.waitFor(() => {
        expect(harness.saved.get(harness.chatId)?.transcript).toHaveLength(1);
      });
      expect(sends).toBe(1);
      expect(received.map(value => value.text)).toEqual(['Keep going']);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.steering?.[0]?.text).toBe('Keep going');
      await expect(harness.runtime.handle(command)).rejects.toThrow();
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });

  it('starts a build with the plan’s todos on the building chat and keeps building after the turn ends', async () => {
    let seen: unknown;
    const harness = await fixture(async () => {
      seen = harness.saved.get(harness.chatId)?.todos;
    });
    try {
      const plan = (
        await harness.glyph.updatePlan(toSummary(harness.saved.get(harness.chatId)!), {
          id: null,
          expectedRevision: null,
          title: 'Ship it',
          summary: 'Summary',
          markdown: '# Ship it',
          todos: [
            { id: 'first', text: 'First', completed: true },
            { id: 'second', text: 'Second', completed: false },
          ],
        })
      ).plans!.at(-1)!;
      const planBuild = {
        planId: plan.id,
        revision: plan.revision,
        title: plan.title,
        sourceChatId: harness.chatId,
        todos: plan.todos,
      };
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Build this approved plan',
        attachments: [],
        options: { planBuild },
      });
      await vi.waitFor(() => {
        expect(harness.saved.get(harness.chatId)?.transcript).toHaveLength(1);
      });
      await new Promise<void>(resolve => {
        setTimeout(resolve);
      });

      expect(seen).toEqual([
        { id: `plan:${plan.id}:first`, text: 'First', status: 'completed' },
        { id: `plan:${plan.id}:second`, text: 'Second', status: 'pending' },
      ]);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.options?.planBuild).toEqual(planBuild);
      expect(harness.saved.get(harness.chatId)?.plans?.at(-1)?.build).toMatchObject({
        chatId: harness.chatId,
        runId: 'run',
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('finishes a build without todos when its turn ends, and ticks or stops builds on request', async () => {
    const harness = await fixture(async () => {});
    try {
      const chat = toSummary(harness.saved.get(harness.chatId)!);
      const empty = (
        await harness.glyph.updatePlan(chat, {
          id: null,
          expectedRevision: null,
          title: 'Empty',
          summary: 'Summary',
          markdown: '# Empty',
          todos: [],
        })
      ).plans!.at(-1)!;
      const eventCount = harness.events.length;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Build this approved plan',
        attachments: [],
        options: {
          planBuild: {
            planId: empty.id,
            revision: 1,
            title: 'Empty',
            sourceChatId: harness.chatId,
            todos: [],
          },
        },
      });
      await vi.waitFor(() => {
        expect(harness.saved.get(harness.chatId)?.plans?.find(plan => plan.id === empty.id)?.build).toBeUndefined();
      });
      await vi.waitFor(() => {
        expect(
          harness.events
            .slice(eventCount)
            .some(
              event =>
                event.type === GlyphHostEventType.CHAT_UPDATED &&
                event.chat.plans?.findLast(plan => plan.id === empty.id)?.build === undefined,
            ),
        ).toBe(true);
      });
      const listed = (
        await harness.glyph.updatePlan(chat, {
          id: null,
          expectedRevision: null,
          title: 'Listed',
          summary: 'Summary',
          markdown: '# Listed',
          todos: [{ id: 'step', text: 'Step', completed: false }],
        })
      ).plans!.at(-1)!;
      await harness.glyph.startPlanBuild(harness.chatId, listed.id, harness.chatId, 'later');

      await harness.runtime.handle({
        type: Command.SET_PLAN_TODO,
        chatId: harness.chatId,
        planId: listed.id,
        todoId: 'step',
        completed: true,
      });
      const ticked = harness.saved.get(harness.chatId)!;
      await harness.glyph.startPlanBuild(harness.chatId, listed.id, harness.chatId, 'again');
      await harness.runtime.handle({ type: Command.STOP_PLAN_BUILD, chatId: harness.chatId, planId: listed.id });

      expect(ticked.plans!.at(-1)).toMatchObject({ todos: [{ completed: true }] });
      expect(ticked.plans!.at(-1)!.build).toBeUndefined();
      expect(ticked.todos).toEqual([{ id: `plan:${listed.id}:step`, text: 'Step', status: 'completed' }]);
      expect(harness.saved.get(harness.chatId)!.plans!.at(-1)!.build).toBeUndefined();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('publishes independent branches and replaces stale runs on restore, including after reopening', async () => {
    const harness = await fixture(async options => {
      options.onText('Answer');
    });
    try {
      for (const runId of ['first', 'second']) {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId,
          text: runId,
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs.find(run => run.runId === runId)?.status).toBe(
            GlyphRunStatus.COMPLETED,
          );
        });
      }
      await harness.runtime.handle({
        type: Command.BRANCH_CHAT,
        chatId: harness.chatId,
        turnId: 'first',
        creationId: 'fork',
      });
      const created = harness.events.find(
        event => event.type === GlyphHostEventType.CHAT_UPDATED && event.creationId === 'fork',
      );
      expect(created?.type).toBe(GlyphHostEventType.CHAT_UPDATED);
      if (created?.type !== GlyphHostEventType.CHAT_UPDATED) throw new Error('Missing branch event');
      const forkId = created.chat.id;
      expect(forkId).not.toBe(harness.chatId);
      expect(harness.saved.get(forkId)?.transcript.map(turn => turn.userText)).toEqual(['first']);
      await harness.runtime.handle({ type: Command.RESTORE_CHECKPOINT, chatId: harness.chatId, turnId: 'second' });
      const restored = harness.events.findLast(event => event.type === GlyphHostEventType.CHAT_RESTORED);
      expect(restored).toMatchObject({
        chatId: harness.chatId,
        draft: { text: 'second' },
        runs: [{ checkpointTurnId: 'first' }],
      });
      expect((await harness.runtime.snapshot()).runs.filter(run => run.chatId === harness.chatId)).toHaveLength(1);
      expect(harness.saved.get(harness.chatId)?.transcript).toHaveLength(1);
      expect(harness.saved.get(forkId)?.transcript).toHaveLength(1);
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      expect((await harness.runtime.snapshot()).runs.filter(run => run.chatId === harness.chatId)).toHaveLength(1);
      await expect(
        harness.runtime.handle({ type: Command.RESTORE_CHECKPOINT, chatId: harness.chatId, turnId: 'second' }),
      ).rejects.toThrow('no longer');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('checks proposal ownership before publishing any preview content', async () => {
    const { reviews, stage } = reviewFixture();
    const harness = await fixture(async () => {}, 'owner', reviews);
    try {
      const staged = await stage('another-chat');
      const proposal = reviews.get(staged.proposalId)!;
      await expect(
        harness.runtime.handle({
          type: Command.READ_PROPOSAL_FILE,
          chatId: harness.chatId,
          proposalId: staged.proposalId,
          fileId: proposal.files[0]!.id,
        }),
      ).rejects.toThrow('This proposal does not belong to that chat.');
      expect(harness.events.some(event => event.type === GlyphHostEventType.PROPOSAL_PREVIEW)).toBe(false);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps the latest account catalog when an older discovery finishes later', async () => {
    const harness = await fixture(async () => {});
    const first = harness.backend.accounts[0]!;
    const second = { ...first, id: 'second', label: 'Second' };
    Object.defineProperty(harness.backend, 'accounts', { value: [first, second] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    harness.backend.listModels = async account => {
      if (account.id === first.id) await gate;
      return [{ slug: `${account.id}-model`, name: account.id }];
    };
    try {
      const pending = harness.runtime.handle({
        type: Command.SELECT_ACCOUNT,
        accountProvider: 'fixture',
        accountId: first.id,
      });
      await harness.runtime.handle({ type: Command.SELECT_ACCOUNT, accountProvider: 'fixture', accountId: second.id });
      release();
      await pending;
      expect(await harness.runtime.snapshot()).toMatchObject({
        selectedAccount: { id: second.id },
        selectedModel: 'second-model',
        models: [{ slug: 'second-model' }],
      });
      await harness.runtime.handle({ type: Command.SELECT_MODEL, model: 'second-model' });
      await expect(harness.runtime.handle({ type: Command.SELECT_MODEL, model: 'account-model' })).rejects.toThrow(
        'available model',
      );
    } finally {
      release();
      await harness.runtime.dispose();
    }
  });

  it('correlates the created chat with its request while ordinary chat updates remain uncorrelated', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({
        type: Command.CREATE_CHAT,
        creationId: 'create-choice',
        accountProvider: 'fixture',
        accountId: 'account',
        model: 'model',
      });
      const created = harness.events.filter(
        event => event.type === GlyphHostEventType.CHAT_UPDATED && event.creationId === 'create-choice',
      );
      expect(created).toHaveLength(1);
      const event = created[0]!;
      if (event.type !== GlyphHostEventType.CHAT_UPDATED) throw new Error('Expected chat');
      expect(event.chat.id).not.toBe(harness.chatId);
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: event.chat.id });
      expect(harness.events.at(-1)).toMatchObject({
        type: GlyphHostEventType.CHAT_UPDATED,
        chat: { id: event.chat.id },
      });
      expect(harness.events.at(-1)).not.toHaveProperty('creationId');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('totals saved turns per chat and replaces totals on repeated open, including missing reports', async () => {
    let reports = 0;
    const harness = await fixture(async () => (++reports === 2 ? null : usage));
    const other = await harness.glyph.createChat(harness.glyph.accounts[0]!, { slug: 'model', name: 'Model' });
    try {
      for (const [index, chatId] of [harness.chatId, harness.chatId, other.id, harness.chatId].entries()) {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId,
          runId: `run-${index}`,
          text: 'Continue',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[index]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
      }
      const expected = {
        inputTokens: 4,
        outputTokens: 6,
        cachedInputTokens: 0,
        reasoningTokens: 2,
        totalTokens: 10,
        unreportedTurns: 1,
      };
      for (let i = 0; i < 2; i++) {
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
        expect((await harness.runtime.snapshot()).usageByChat).toEqual({
          [harness.chatId]: expected,
          [other.id]: { ...usage, unreportedTurns: 0 },
        });
      }
      expect(harness.saved.get(harness.chatId)?.transcript.map(turn => turn.usage)).toEqual([usage, undefined, usage]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('does not publish or count a completed provider result when its transcript checkpoint fails', async () => {
    const harness = await fixture(async () => {});
    const save = harness.store.save;
    harness.store.save = async () => {
      throw new Error('disk unavailable');
    };
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'failed-save',
        text: 'First',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.FAILED);
      });
      expect(harness.events.filter(event => event.type === GlyphHostEventType.USAGE)).toEqual([]);
      expect(harness.saved.get(harness.chatId)?.transcript).toHaveLength(0);
      harness.store.save = save;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'saved',
        text: 'Next',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[1]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect((await harness.runtime.snapshot()).usageByChat?.[harness.chatId]).toEqual({
        ...usage,
        unreportedTurns: 0,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps live shells attached to their execution when a provider reuses a call id in later turns', async () => {
    let sequence = 0;
    const harness = await fixture(async options => {
      sequence++;
      options.onToolActivity?.({
        callId: 'reused',
        executionId: `execution-${sequence}`,
        namespace: 'shell',
        name: 'execute_shell',
        arguments: JSON.stringify({ command: `command-${sequence}`, background: true }),
        phase: ToolActivityPhase.COMPLETED,
        output: JSON.stringify({ terminal_id: `session-${sequence}`, output: '' }),
      });
    });
    try {
      for (const runId of ['first', 'second']) {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId,
          text: 'Start a shell',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs.find(run => run.runId === runId)?.status).toBe(
            GlyphRunStatus.COMPLETED,
          );
        });
      }
      harness.shells.allSessions = [1, 2].map(index => ({
        id: `session-${index}`,
        executionId: `execution-${index}`,
        ownerChatId: harness.chatId,
        command: `command-${index}`,
        outputTail: `secret output-${index}`,
        workingDirectory: '/project',
        status: ShellSessionStatus.RUNNING,
        background: true,
        startedAt: new Date().toISOString(),
      }));
      harness.emitShells();
      expect((await harness.runtime.snapshot()).runs.map(run => run.tools[0]?.shell)).toMatchObject([
        { sessionId: 'session-1', output: '[REDACTED] output-1', running: true, live: true },
        { sessionId: 'session-2', output: '[REDACTED] output-2', running: true, live: true },
      ]);
      harness.shells.allSessions.shift();
      harness.emitShells();
      expect((await harness.runtime.snapshot()).runs.map(run => run.tools[0]?.shell?.live)).toEqual([false, true]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps tool batches separate across assistant text and retains the starting position when a call finishes', async () => {
    const harness = await fixture(async options => {
      options.onToolActivity?.({ callId: 'first', name: 'read', phase: ToolActivityPhase.STARTED, arguments: '{}' });
      options.onText('Between calls.');
      options.onToolActivity?.({
        callId: 'second',
        name: 'read',
        phase: ToolActivityPhase.COMPLETED,
        arguments: '{}',
        output: 'x'.repeat(20_000),
      });
      options.onToolActivity?.({
        callId: 'first',
        name: 'read',
        phase: ToolActivityPhase.COMPLETED,
        arguments: '{}',
        output: 'Finished first.',
      });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'batches',
        text: 'Read',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      const tools = (await harness.runtime.snapshot()).runs[0]!.tools;
      expect(tools.map(tool => tool.textOffset)).toEqual([0, 'Between calls.'.length]);
      expect(tools[1]!.summary).toBe(`${'x'.repeat(16_000)}\n… (truncated)`);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.tools?.map(tool => tool.textOffset)).toEqual([
        0,
        'Between calls.'.length,
      ]);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.tools?.[1]?.output).toBe(tools[1]!.summary);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps tool call order stable and restores compact progress from completed turns', async () => {
    const harness = await fixture(async options => {
      for (const [callId, phase] of [
        ['first', ToolActivityPhase.STARTED],
        ['second', ToolActivityPhase.STARTED],
        ['second', ToolActivityPhase.FAILED],
        ['first', ToolActivityPhase.COMPLETED],
      ] as const)
        options.onToolActivity?.({
          callId,
          name: 'read',
          phase,
          arguments: '{}',
          output: 'secret tool result',
        });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'tools',
        text: 'Read',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      const expected = [
        {
          id: 'first',
          name: 'read',
          status: 'completed',
          arguments: '{}',
          summary: '[REDACTED] tool result',
          textOffset: 0,
        },
        {
          id: 'second',
          name: 'read',
          status: 'failed',
          arguments: '{}',
          summary: '[REDACTED] tool result',
          textOffset: 0,
        },
      ];
      expect((await harness.runtime.snapshot()).runs[0]?.tools).toMatchObject(expected);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.tools).toEqual([
        {
          callId: 'first',
          name: 'read',
          phase: ToolActivityPhase.COMPLETED,
          arguments: '{}',
          output: 'secret tool result',
          textOffset: 0,
        },
        {
          callId: 'second',
          name: 'read',
          phase: ToolActivityPhase.FAILED,
          arguments: '{}',
          output: 'secret tool result',
          textOffset: 0,
        },
      ]);
      const restored = new ProviderDesktopRuntime({
        glyph: harness.glyph,
        interactions: new DesktopInteractionBroker(() => {}),
        shellSessions: harness.shells,
        emit: () => {},
        ownerWindowId: 'owner',
      });
      await restored.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      await restored.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      const snapshot = await restored.snapshot();
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0]?.tools).toEqual(expected);
      expect(snapshot.runs[0]?.usage).toEqual({ ...usage, unreportedTurns: 0 });
      expect(snapshot.runs[0]?.createdAt).toBe(harness.saved.get(harness.chatId)?.transcript[0]?.createdAt);
      expect(snapshot.usageByChat?.[harness.chatId]).toEqual({ ...usage, unreportedTurns: 0 });
      await restored.dispose();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('leaves ownerless legacy receipts for explicit workspace-wide delivery instead of attributing them to concurrent chats', async () => {
    const { reviews, stage } = reviewFixture();
    const harness = await fixture(async () => {}, 'owner', reviews);
    const proposal = await stage(harness.chatId, false);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    const account = harness.glyph.accounts[0]!;
    const other = await harness.glyph.createChat(account, { slug: 'model', name: 'Model' });
    try {
      await Promise.all(
        [harness.chatId, other.id].map(chatId =>
          harness.runtime.handle({
            type: Command.SEND,
            chatId,
            runId: chatId,
            text: 'Continue',
            attachments: [],
          }),
        ),
      );
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.map(run => run.status)).toEqual([
          GlyphRunStatus.COMPLETED,
          GlyphRunStatus.COMPLETED,
        ]);
      });
      expect(harness.recorded).toEqual([[], []]);
      expect(reviews.pendingResults).toHaveLength(1);
      await harness.glyph.commitReviewResults(harness.glyph.openChat(harness.chatId, account));
      expect(harness.recorded.map(events => events.length)).toEqual([1, 0]);
      expect(reviews.pendingResults).toEqual([]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('retries a cancelled receipt save before the next turn without losing or duplicating the durable decision', async () => {
    const { reviews, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalSave = harness.store.save;
    let attempts = 0;
    harness.store.save = async record => {
      attempts++;
      if (attempts === 1) {
        await gate;
        throw new Error('Temporary receipt storage failure');
      }
      await originalSave(record);
    };
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'cancelled',
        text: 'First',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(attempts).toBe(1);
      });
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'cancelled' });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
      });
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'retry',
        text: 'Retry',
        attachments: [],
      });
      expect(send).not.toHaveBeenCalled();
      release();
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[1]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect(send).toHaveBeenCalledOnce();
      expect(harness.recorded[0]).toHaveLength(1);
      expect(harness.saved.get(harness.chatId)?.providerState.data).toEqual(harness.recorded[0]);
      expect(reviews.pendingResults).toEqual([]);
    } finally {
      release();
      await harness.runtime.dispose();
    }
  });

  it.each(['question', 'approval'] as const)(
    'continues another chat while a review receipt waits behind its owner’s %s',
    async waitingOn => {
      const { reviews, stage } = reviewFixture();
      let owner = '';
      const calls: string[] = [];
      const harness = await fixture(
        async (options, interactions) => {
          const chat = options.toolContext!.chat!.id;
          calls.push(chat);
          if (chat !== owner) return;
          if (waitingOn === 'approval') {
            await interactions.presentShellPermission(
              { command: 'true', workingDirectory: '/project' },
              options.signal,
            );
            return;
          }
          await interactions.present(
            {
              questions: [
                {
                  id: 'q',
                  prompt: 'Continue?',
                  allowMultiple: false,
                  options: [{ id: 'yes', label: 'Yes' }],
                },
              ],
            },
            options.signal,
          );
        },
        'owner',
        reviews,
      );
      owner = harness.chatId;
      const other = await harness.glyph.createChat(harness.glyph.accounts[0]!, { slug: 'model', name: 'Model' });
      const proposal = await stage(owner);
      let deciding: Promise<void> | undefined;
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: owner,
          runId: 'owner-run',
          text: 'Wait',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(
            waitingOn === 'question' ? GlyphRunStatus.WAITING_FOR_QUESTION : GlyphRunStatus.WAITING_FOR_APPROVAL,
          );
        });
        deciding = harness.runtime.handle({ type: Command.REJECT_PROPOSAL_ITEM, chatId: owner, ...proposal });
        await vi.waitFor(() => {
          expect(reviews.pendingResults).toHaveLength(1);
        });
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: other.id,
          runId: 'other-run',
          text: 'Independent work',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs.find(run => run.runId === 'other-run')?.status).toBe(
            GlyphRunStatus.COMPLETED,
          );
        });
        expect(calls).toEqual([owner, other.id]);
        expect(harness.recorded[1]).toEqual([]);
        expect(reviews.pendingResults).toHaveLength(1);
        await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: owner, runId: 'owner-run' });
        await deciding;
        expect(harness.recorded[0]).toHaveLength(1);
        expect(harness.saved.get(owner)?.providerState.data).toEqual(harness.recorded[0]);
        expect(reviews.pendingResults).toEqual([]);
      } finally {
        await harness.runtime.dispose();
        await deciding;
      }
    },
  );

  it('cancels a turn during receipt persistence while teardown still drains the admitted save', async () => {
    const { reviews, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalSave = harness.store.save;
    let saving = false;
    harness.store.save = async record => {
      saving = true;
      await gate;
      await originalSave(record);
    };
    const close = vi.spyOn(harness.store, 'dispose');
    let stopping: Promise<void> | undefined;
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Continue',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(saving).toBe(true);
      });
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'run' });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
      });
      expect(send).not.toHaveBeenCalled();
      expect(reviews.pendingResults).toHaveLength(1);
      stopping = harness.runtime.dispose();
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(close).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(close).toHaveBeenCalledOnce();
      expect(reviews.pendingResults).toEqual([]);
      expect(harness.saved.get(harness.chatId)?.providerState.data).toEqual(harness.recorded[0]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      release();
      await (stopping ?? harness.runtime.dispose());
    }
  });

  it('cancels before a pending review checkpoint finishes without starting late inference', async () => {
    const { reviews, store, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    store.save.mockImplementation(async () => gate);
    const rejecting = reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Continue',
        attachments: [],
      });
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'run' });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
      });
      expect(send).not.toHaveBeenCalled();
      release();
      await rejecting;
      await harness.runtime.dispose();
      expect(send).not.toHaveBeenCalled();
      expect(reviews.pendingResults).toHaveLength(1);
    } finally {
      release();
      await rejecting;
      await harness.runtime.dispose();
    }
  });

  it.each(['detach', 'revoke trust'] as const)(
    'allows the host to %s during model discovery without waiting for its response',
    async transition => {
      const first = await fixture(async () => {});
      const nextWindow = transition === 'detach' ? 'peer' : 'owner';
      const replacement = await fixture(async () => {}, nextWindow);
      const runtimes = [first.runtime, replacement.runtime];
      const host = new GlyphDesktopHost({ create: async () => runtimes.shift()! });
      const events: GlyphHostEvent[] = [];
      const identity = { profileId: 'fixture', windowId: 'owner', workspaceId: 'project' };
      const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];
      let request = 0;
      const receive = (windowId: string, command: GlyphWorkbenchCommand) =>
        host.receive(windowId, {
          ...identity,
          windowId,
          protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
          requestId: String(++request),
          command,
        });
      host.connect('owner', identity, envelope => {
        events.push(envelope.event);
      });
      await receive('owner', { type: Command.ATTACH_WORKSPACE, roots, trusted: true });
      let release!: () => void;
      let discoverySignal: AbortSignal | undefined;
      first.backend.listModels = (_account, signal) =>
        new Promise((resolve, reject) => {
          discoverySignal = signal;
          const abort = () => {
            reject(signal?.reason);
          };
          release = () => {
            signal?.removeEventListener('abort', abort);
            resolve([{ slug: 'next', name: 'Next' }]);
          };
          signal?.addEventListener('abort', abort, { once: true });
        });
      const discovering = receive('owner', {
        type: Command.SELECT_ACCOUNT,
        accountProvider: 'fixture',
        accountId: 'account',
      });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      let transitioned = false;
      const changing = receive(
        'owner',
        transition === 'detach' ? { type: Command.DETACH } : { type: Command.ATTACH_WORKSPACE, roots, trusted: false },
      ).then(() => {
        transitioned = true;
      });
      try {
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
        expect(discoverySignal?.aborted).toBe(true);
        expect(transitioned).toBe(true);
        if (transition === 'detach') {
          host.connect('peer', { ...identity, windowId: 'peer' }, envelope => {
            events.push(envelope.event);
          });
          await receive('peer', { type: Command.ATTACH_WORKSPACE, roots, trusted: true });
        }
        expect(events.findLast(event => event.type === GlyphHostEventType.INITIAL_STATE)).toMatchObject({
          state: { ownerWindowId: nextWindow, readOnly: false },
        });
        expect(first.shells.dispose).toHaveBeenCalledOnce();
      } finally {
        release();
        await Promise.all([discovering, changing]);
        await host.dispose();
        await replacement.runtime.dispose();
      }
    },
  );

  it.each(
    ([Command.SELECT_ACCOUNT, Command.CREATE_CHAT] as const).flatMap(type =>
      (['dispose', 'disconnect'] as const).map(retirement => ({ type, retirement })),
    ),
  )('cancels $type discovery on $retirement before closing its dependencies', async ({ type, retirement }) => {
    const harness = await fixture(async () => {});
    let release!: () => void;
    let discoverySignal: AbortSignal | undefined;
    const get = vi.fn<HttpClient['get']>(
      (_url, options) =>
        new Promise((resolve, reject) => {
          discoverySignal = options?.signal;
          const abort = () => {
            reject(discoverySignal?.reason);
          };
          release = () => {
            discoverySignal?.removeEventListener('abort', abort);
            resolve({
              ok: true,
              status: 200,
              headers: new Headers(),
              body: {
                models: [{ slug: 'next', display_name: 'Next', visibility: 'list' }],
              },
            });
          };
          if (discoverySignal?.aborted === true) abort();
          else discoverySignal?.addEventListener('abort', abort, { once: true });
        }),
    );
    const catalog = new OpenAIModelCatalog(
      {
        issuer: 'https://auth.example.test',
        resource: 'https://api.example.test',
        scopes: 'openid',
        planScope: 'plan',
        requestTimeoutMs: 30_000,
      },
      { get, post: vi.fn() },
    );
    harness.backend.listModels = (_account, signal) => catalog.list('fixture-token', signal);
    const command = { type, accountProvider: 'fixture', accountId: 'account', model: 'next' };
    let outcome: 'pending' | 'completed' | 'cancelled' = 'pending';
    const pending = harness.runtime.handle(command).then(
      () => {
        outcome = 'completed';
      },
      () => {
        outcome = 'cancelled';
      },
    );
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledOnce();
    });
    let stopped = false;
    const stopping = (
      retirement === 'dispose' ? harness.runtime.dispose() : harness.runtime.connectionLost('owner')
    ).then(() => {
      stopped = true;
    });
    try {
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(discoverySignal?.aborted).toBe(true);
      expect(outcome).toBe('cancelled');
      expect(stopped).toBe(true);
      expect(harness.saved.size).toBe(1);
      expect((await harness.runtime.snapshot()).selectedModel).toBe('model');
    } finally {
      release();
      await Promise.all([pending, stopping]);
      if (retirement !== 'dispose') await harness.runtime.dispose();
    }
  });

  it.each([Command.SELECT_ACCOUNT, Command.CREATE_CHAT] as const)(
    'ignores a late discovery result after its owner disconnects during %s',
    async type => {
      const harness = await fixture(async () => {});
      let release!: () => void;
      harness.backend.listModels = () =>
        new Promise(resolve => {
          release = () => {
            resolve([{ slug: 'next', name: 'Next' }]);
          };
        });
      const pending = harness.runtime.handle({ type, accountProvider: 'fixture', accountId: 'account', model: 'next' });
      const result = pending.then(
        () => 'completed',
        () => 'cancelled',
      );
      try {
        await harness.runtime.connectionLost('owner');
        release();
        expect(await result).toBe('cancelled');
        expect(harness.saved.size).toBe(1);
        expect((await harness.runtime.snapshot()).selectedModel).toBe('model');
      } finally {
        release();
        await result;
        await harness.runtime.dispose();
      }
    },
  );

  it('lets a reconnected owner discover models again and ignores a peer disconnect', async () => {
    const harness = await fixture(async () => {});
    const signals: (AbortSignal | undefined)[] = [];
    harness.backend.listModels = async (_account, signal) => {
      signals.push(signal);
      signal?.throwIfAborted();
      return [{ slug: 'next', name: 'Next' }];
    };
    const command = { type: Command.SELECT_ACCOUNT, accountProvider: 'fixture', accountId: 'account' } as const;
    try {
      await harness.runtime.handle(command);
      await harness.runtime.connectionLost('peer');
      expect(signals[0]?.aborted).toBe(false);
      await harness.runtime.connectionLost('owner');
      expect(signals[0]?.aborted).toBe(true);
      await harness.runtime.handle(command);
      expect(signals[1]?.aborted).toBe(false);
      expect(signals[1]).not.toBe(signals[0]);
      expect((await harness.runtime.snapshot()).selectedModel).toBe('next');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('finishes an admitted chat checkpoint before storage closes and suppresses its disconnected notification', async () => {
    const harness = await fixture(async () => {});
    const save = harness.store.save.bind(harness.store);
    let release!: () => void;
    const saving = vi.spyOn(harness.store, 'save').mockImplementation(
      record =>
        new Promise<void>(resolve => {
          release = () => {
            void save(record).then(resolve);
          };
        }),
    );
    const closed = vi.spyOn(harness.store, 'dispose');
    const eventCount = harness.events.length;
    const pending = harness.runtime.handle({
      type: Command.CREATE_CHAT,
      accountProvider: 'fixture',
      accountId: 'account',
      model: 'model',
    });
    const result = pending.then(
      () => 'completed',
      () => 'cancelled',
    );
    await vi.waitFor(() => {
      expect(saving).toHaveBeenCalledOnce();
    });
    const stopping = harness.runtime.dispose();
    try {
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(closed).not.toHaveBeenCalled();
    } finally {
      release();
      await stopping;
    }
    expect(await result).toBe('cancelled');
    expect(harness.saved.size).toBe(2);
    expect(closed).toHaveBeenCalledOnce();
    expect(harness.events).toHaveLength(eventCount);
  });

  it('shares teardown across repeated disposal calls so dependencies close once', async () => {
    const harness = await fixture(async () => {});
    const close = vi.spyOn(harness.backend, 'dispose');
    await Promise.all([harness.runtime.dispose(), harness.runtime.dispose()]);
    expect(close).toHaveBeenCalledOnce();
    expect(harness.shells.dispose).toHaveBeenCalledOnce();
  });
  it('cancels an active provider turn and terminates background shells during trust-boundary disposal', async () => {
    const harness = await fixture(async options => {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
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

  it('stops managed shells before waiting for a cancelled provider to settle', async () => {
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    let finish!: () => void;
    const drained = new Promise<void>(resolve => {
      finish = resolve;
    });
    const harness = await fixture(async options => {
      started();
      await new Promise<void>(resolve => {
        options.signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      await drained;
    });
    harness.shells.dispose.mockImplementation(async () => {
      finish();
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'blocked',
        text: 'Continue',
        attachments: [],
      });
      await running;
      await harness.runtime.dispose();
      expect(harness.shells.dispose).toHaveBeenCalledOnce();
      expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
    } finally {
      finish();
      await harness.runtime.dispose();
    }
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
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
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
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect(harness.saved.get(harness.chatId)?.transcript).toMatchObject([
        { userText: 'Question', assistantText: 'Answer', reasoningSummary: 'Summary' },
      ]);
      expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
        text: 'Answer',
        reasoning: 'Summary',
        usage: { ...usage, unreportedTurns: 0 },
        createdAt: harness.saved.get(harness.chatId)?.transcript[0]?.createdAt,
        tools: [{ id: 'tool' }],
      });
      expect((await harness.runtime.snapshot()).usageByChat?.[harness.chatId]).toEqual({
        ...usage,
        unreportedTurns: 0,
      });
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
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_QUESTION);
      });
      const question = (await harness.runtime.snapshot()).runs[0]!.question!;
      await harness.runtime.handle({
        type: Command.ANSWER_QUESTION,
        chatId: harness.chatId,
        runId: 'run',
        questionId: question.id,
        answer: { answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['one'] }] },
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
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
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
      });
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

  it('refuses to carry out a command after it has stopped', async () => {
    const harness = await fixture(async () => {});
    await harness.runtime.dispose();

    await expect(
      (harness.runtime as unknown as { dispatch(command: GlyphRuntimeCommand): Promise<void> }).dispatch({
        type: Command.LIST_CHATS,
      }),
    ).rejects.toThrow('The workspace runtime has stopped.');
  });

  describe(ProviderDesktopRuntime.prototype.handle, () => {
    it('refuses commands once the runtime has stopped', async () => {
      const harness = await fixture(async () => {});
      await harness.runtime.dispose();
      await expect(harness.runtime.handle({ type: Command.LIST_CHATS })).rejects.toThrow(
        'The workspace runtime has stopped.',
      );
    });

    it.each<GlyphRuntimeCommand>([
      {
        type: Command.START_AGENT_REVIEW,
        review: agentReviewInput(),
        model: { accountProvider: 'fixture', accountId: 'account', model: 'model' },
      },
      { type: Command.CANCEL_AGENT_REVIEW, reviewId: 'review' },
      { type: Command.DISMISS_AGENT_REVIEW_FINDING, reviewId: 'review', findingId: 'finding' },
    ])('reports agent review as unavailable without a review service ($type)', async command => {
      const harness = await fixture(async () => {});
      try {
        await expect(harness.runtime.handle(command)).rejects.toThrow('Agent review is unavailable.');
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('starts an agent review only with inference access and an available model', async () => {
      const agentReviews = agentReviewsFake();
      const harness = await fixture(async () => {}, 'owner', undefined, { agentReviews: agentReviews.service });
      try {
        const review = agentReviewInput();
        const model = { accountProvider: 'fixture', accountId: 'account', model: 'model' };
        await expect(
          harness.runtime.handle({ type: Command.START_AGENT_REVIEW, review, model: { ...model, model: 'missing' } }),
        ).rejects.toThrow('The selected review model is unavailable.');
        vi.spyOn(harness.glyph, 'hasInferenceAccess').mockReturnValueOnce(false);
        await expect(harness.runtime.handle({ type: Command.START_AGENT_REVIEW, review, model })).rejects.toThrow(
          'The selected account cannot run reviews.',
        );
        await harness.runtime.handle({ type: Command.START_AGENT_REVIEW, review, model });
        expect(agentReviews.start).toHaveBeenCalledExactlyOnceWith(review, model);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('cancels agent reviews and dismisses their findings', async () => {
      const agentReviews = agentReviewsFake();
      const harness = await fixture(async () => {}, 'owner', undefined, { agentReviews: agentReviews.service });
      try {
        await harness.runtime.handle({ type: Command.CANCEL_AGENT_REVIEW, reviewId: 'review' });
        await harness.runtime.handle({
          type: Command.DISMISS_AGENT_REVIEW_FINDING,
          reviewId: 'review',
          findingId: 'finding',
        });
        expect(agentReviews.cancel).toHaveBeenCalledExactlyOnceWith('review');
        expect(agentReviews.dismiss).toHaveBeenCalledExactlyOnceWith('review', 'finding');
      } finally {
        await harness.runtime.dispose();
      }
      expect(agentReviews.dispose).toHaveBeenCalledOnce();
    });

    it('lists the chats of one account or of every account', async () => {
      const harness = await fixture(async () => {});
      try {
        const listChats = vi.spyOn(harness.glyph, 'listChats');
        await harness.runtime.handle({ type: Command.LIST_CHATS, accountProvider: 'fixture', accountId: 'account' });
        expect(listChats).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'fixture', id: 'account' }));
        await harness.runtime.handle({ type: Command.LIST_CHATS, accountProvider: 'fixture' });
        expect(listChats).toHaveBeenLastCalledWith(undefined);
        expect(
          harness.events.filter(
            event => event.type === GlyphHostEventType.CHAT_UPDATED && event.chat.id === harness.chatId,
          ),
        ).toHaveLength(3);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('rejects opening a chat from another workspace', async () => {
      const harness = await fixture(async () => {});
      try {
        await expect(harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: 'elsewhere' })).rejects.toThrow(
          'Unknown chat in this workspace.',
        );
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('refuses to change history while the chat is responding', async () => {
      const gate = deferredVoid();
      const entered = deferredVoid();
      const harness = await fixture(async () => {
        entered.resolve();
        await gate.promise;
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Work',
          attachments: [],
        });
        await entered.promise;
        await expect(
          harness.runtime.handle({
            type: Command.BRANCH_CHAT,
            chatId: harness.chatId,
            turnId: 'run',
            creationId: 'fork',
          }),
        ).rejects.toThrow('Wait for this chat to finish before changing its history.');
      } finally {
        gate.resolve();
        await harness.runtime.dispose();
      }
    });

    it('restores the draft of a checkpointed turn together with its captured attachments', async () => {
      const checkpoint = {
        providerState: { provider: 'fixture', version: 1, data: [] },
        plans: [],
        todos: [],
        mode: AgentModeID.AGENT,
      };
      const range = { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } };
      const record = chatRecord({
        transcript: [
          {
            userText: 'First',
            attachmentPaths: [],
            assistantText: 'One',
            reasoningSummary: '',
            createdAt: '2026-10-01T00:00:00.000Z',
            checkpoints: { before: checkpoint, after: checkpoint },
          },
          {
            userText: 'Second',
            attachmentPaths: ['plain.ts', 'legacy.ts', 'diagnostic.ts'],
            assistantText: 'Two',
            reasoningSummary: '',
            createdAt: '2026-10-02T00:00:00.000Z',
            options: { turnId: 'second', mode: AgentModeID.PLAN },
            checkpoints: { before: checkpoint, after: checkpoint },
            attachments: [
              { path: 'plain.ts', text: 'plain', revision: 'r1', byteOrderMark: false, byteLength: 5 },
              {
                path: 'legacy.ts',
                text: 'legacy',
                revision: 'r2',
                byteOrderMark: false,
                byteLength: 6,
                source: {
                  kind: 'legacy-range' as ContextAttachmentSource['kind'],
                  uri: 'file:///project/legacy.ts',
                  version: 3,
                  revision: 's2',
                  range,
                  side: 'modified',
                },
              },
              {
                path: 'diagnostic.ts',
                text: 'diagnostic',
                revision: 'r3',
                byteOrderMark: false,
                byteLength: 10,
                source: { kind: 'diagnostic', uri: 'file:///project/diagnostic.ts', version: 1, revision: 's3' },
              },
            ],
          },
        ],
      });
      const harness = await fixture(async () => {}, 'owner', undefined, { records: [record] });
      try {
        await harness.runtime.handle({ type: Command.RESTORE_CHECKPOINT, chatId: record.id, turnId: 'second' });
        expect(harness.events.findLast(event => event.type === GlyphHostEventType.CHAT_RESTORED)).toEqual({
          type: GlyphHostEventType.CHAT_RESTORED,
          chatId: record.id,
          runs: [expect.objectContaining({ runId: `${record.id}:history:0`, userText: 'First' })],
          draft: {
            text: 'Second',
            options: { turnId: 'second', mode: AgentModeID.PLAN },
            attachments: [
              {
                kind: GlyphContextAttachmentKind.FILE,
                uri: 'plain.ts',
                path: 'plain.ts',
                text: 'plain',
                contentRevision: 'r1',
                sourceRevision: 'r1',
                sourceVersion: 0,
              },
              {
                kind: GlyphContextAttachmentKind.SELECTION,
                uri: 'file:///project/legacy.ts',
                path: 'legacy.ts',
                text: 'legacy',
                contentRevision: 'r2',
                sourceRevision: 's2',
                sourceVersion: 3,
                range,
                side: 'modified',
              },
              {
                kind: GlyphContextAttachmentKind.DIAGNOSTIC,
                uri: 'file:///project/diagnostic.ts',
                path: 'diagnostic.ts',
                text: 'diagnostic',
                contentRevision: 'r3',
                sourceRevision: 's3',
                sourceVersion: 1,
              },
            ],
          },
        });
        await harness.runtime.handle({
          type: Command.RESTORE_CHECKPOINT,
          chatId: record.id,
          turnId: `${record.id}:history:0`,
        });
        expect(harness.events.findLast(event => event.type === GlyphHostEventType.CHAT_RESTORED)).toMatchObject({
          runs: [],
          draft: { text: 'First', attachments: [] },
        });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('projects every saved detail of a reopened chat history', async () => {
      const checkpoint = {
        providerState: { provider: 'fixture', version: 1, data: [] },
        plans: [],
        todos: [],
        mode: AgentModeID.AGENT,
      };
      const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } };
      const steering = [
        { id: 'steer', text: 'Faster', createdAt: '2026-10-01T00:00:01.000Z', options: {}, attachments: [] },
      ];
      const modeSwaps = [
        {
          id: 'swap',
          source: AgentModeID.PLAN,
          target: AgentModeID.AGENT,
          description: 'Build',
          status: GlyphModeSwapStatus.APPROVED,
          expiresAt: '2026-10-01T00:00:10.000Z',
          autoApprove: false,
        },
      ];
      const questionResponses = [{ id: 'question', answers: [{ question: 'Why?', answer: 'Because' }] }];
      const record = chatRecord({
        transcript: [
          {
            userText: 'Rich',
            attachmentPaths: ['a.ts', 'b.ts'],
            assistantText: 'Answer',
            reasoningSummary: 'Thought',
            createdAt: '2026-10-01T00:00:00.000Z',
            steering,
            modeSwaps,
            questionResponses,
            checkpoints: { before: checkpoint, after: checkpoint },
            usage: { ...usage, incomplete: true },
            options: { mode: AgentModeID.AGENT },
            attachments: [
              {
                path: 'a.ts',
                text: 'abc',
                revision: 'r1',
                byteOrderMark: false,
                byteLength: 3,
                source: {
                  kind: 'selection',
                  uri: 'file:///project/a.ts',
                  version: 2,
                  revision: 's1',
                  range,
                  side: 'original',
                },
              },
              { path: 'b.ts', text: 'b', revision: 'r2', byteOrderMark: false, byteLength: 1 },
            ],
            tools: [
              {
                callId: 'read',
                name: 'read',
                phase: ToolActivityPhase.COMPLETED,
                arguments: '{"secret":true}',
                output: 'secret file',
                textOffset: 2,
              },
              {
                callId: 'shell',
                name: 'execute_shell',
                phase: ToolActivityPhase.FAILED,
                shell: { command: 'echo secret', output: 'secret', background: true, error: 'secret error' },
              },
            ],
          },
          {
            userText: 'Bare',
            attachmentPaths: [],
            assistantText: 'Plain',
            reasoningSummary: '',
            createdAt: '2026-10-02T00:00:00.000Z',
          },
        ],
      });
      const harness = await fixture(async () => {}, 'owner', undefined, { records: [record] });
      try {
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: record.id });
        expect((await harness.runtime.snapshot()).runs).toEqual([
          {
            chatId: record.id,
            runId: `${record.id}:history:0`,
            userText: 'Rich',
            steering,
            createdAt: '2026-10-01T00:00:00.000Z',
            modeSwaps,
            questionResponses,
            checkpointTurnId: `${record.id}:history:0`,
            usage: { ...usage, incomplete: true, unreportedTurns: 1 },
            options: { mode: AgentModeID.AGENT },
            attachments: [
              { path: 'a.ts', uri: 'file:///project/a.ts', text: 'abc', revision: 'r1', range, side: 'original' },
              { path: 'b.ts', text: 'b', revision: 'r2' },
            ],
            text: 'Answer',
            reasoning: 'Thought',
            tools: [
              {
                id: 'read',
                name: 'read',
                status: GlyphToolActivityStatus.COMPLETED,
                arguments: '{"[REDACTED]":true}',
                summary: '[REDACTED] file',
                textOffset: 2,
              },
              {
                id: 'shell',
                name: 'execute_shell',
                status: GlyphToolActivityStatus.FAILED,
                shell: {
                  command: 'echo [REDACTED]',
                  output: '[REDACTED]',
                  background: true,
                  error: '[REDACTED] error',
                  live: false,
                  running: false,
                },
              },
            ],
            status: GlyphRunStatus.COMPLETED,
          },
          {
            chatId: record.id,
            runId: `${record.id}:history:1`,
            userText: 'Bare',
            createdAt: '2026-10-02T00:00:00.000Z',
            text: 'Plain',
            reasoning: '',
            tools: [],
            status: GlyphRunStatus.COMPLETED,
          },
        ]);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('changes the chat mode and publishes the chat', async () => {
      const harness = await fixture(async () => {});
      try {
        await harness.runtime.handle({ type: Command.SET_CHAT_MODE, chatId: harness.chatId, mode: AgentModeID.PLAN });
        expect(harness.events.at(-1)).toMatchObject({
          type: GlyphHostEventType.CHAT_UPDATED,
          chat: { id: harness.chatId, mode: AgentModeID.PLAN },
        });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('shares a saved plan with another chat and puts reviewers into planning', async () => {
      const harness = await fixture(async () => {});
      try {
        await harness.runtime.handle({
          type: Command.CREATE_CHAT,
          accountProvider: 'fixture',
          accountId: 'account',
          model: 'model',
        });
        const targetChatId = harness.glyph.listChats().find(chat => chat.id !== harness.chatId)!.id;
        const source = harness.glyph.listChats().find(chat => chat.id === harness.chatId)!;
        await harness.glyph.updatePlan(source, {
          id: null,
          expectedRevision: null,
          title: 'Plan',
          summary: 'Do it',
          markdown: '# Plan',
          todos: [],
        });
        const plan = harness.glyph
          .listChats()
          .find(chat => chat.id === harness.chatId)!
          .plans!.at(-1)!;
        await expect(
          harness.runtime.handle({
            type: Command.LINK_PLAN,
            chatId: harness.chatId,
            planId: 'missing',
            targetChatId,
            role: 'Builder',
          }),
        ).rejects.toThrow('The plan is unavailable.');
        await harness.runtime.handle({
          type: Command.LINK_PLAN,
          chatId: harness.chatId,
          planId: plan.id,
          targetChatId,
          role: 'Builder',
        });
        expect(harness.glyph.listChats().find(chat => chat.id === targetChatId)?.mode).toBe(AgentModeID.AGENT);
        await harness.runtime.handle({
          type: Command.LINK_PLAN,
          chatId: harness.chatId,
          planId: plan.id,
          targetChatId,
          role: 'Reviewer',
        });
        expect(harness.events.at(-1)).toMatchObject({
          type: GlyphHostEventType.CHAT_UPDATED,
          chat: { id: targetChatId, mode: AgentModeID.PLAN },
        });
        expect(harness.recorded.flat().map(event => event.id)).toEqual([
          `plan:${plan.id}:${plan.revision}:Builder`,
          `plan:${plan.id}:${plan.revision}:Reviewer`,
        ]);
        expect(harness.recorded.flat()[0]).toEqual({
          schemaVersion: 1,
          id: `plan:${plan.id}:${plan.revision}:Builder`,
          type: 'plan_reference',
          payload: { plan, role: 'Builder', authorization: 'Context only. The human must request execution.' },
        });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('saves plan edits but refuses them while the chat is responding', async () => {
      const gate = deferredVoid();
      const entered = deferredVoid();
      const harness = await fixture(async () => {
        entered.resolve();
        await gate.promise;
      });
      try {
        const source = harness.glyph.listChats().find(chat => chat.id === harness.chatId)!;
        await harness.glyph.updatePlan(source, {
          id: null,
          expectedRevision: null,
          title: 'Plan',
          summary: 'Do it',
          markdown: '# Plan',
          todos: [{ id: 'step', text: 'Step', completed: false }],
        });
        const plan = harness.glyph
          .listChats()
          .find(chat => chat.id === harness.chatId)!
          .plans!.at(-1)!;
        await harness.runtime.handle({
          type: Command.UPDATE_PLAN,
          chatId: harness.chatId,
          plan: { ...plan, title: 'Revised' },
        });
        expect(harness.events.at(-1)).toMatchObject({
          type: GlyphHostEventType.CHAT_UPDATED,
          chat: { id: harness.chatId, plans: [plan, { title: 'Revised', revision: plan.revision + 1 }] },
        });
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Work',
          attachments: [],
        });
        await entered.promise;
        await expect(
          harness.runtime.handle({ type: Command.UPDATE_PLAN, chatId: harness.chatId, plan }),
        ).rejects.toThrow('Wait for the active turn before editing the plan.');
      } finally {
        gate.resolve();
        await harness.runtime.dispose();
      }
    });

    it('refuses to reuse a run id', async () => {
      const harness = await fixture(async () => {});
      try {
        const send = {
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Once',
          attachments: [],
        } as const;
        await harness.runtime.handle(send);
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        await expect(harness.runtime.handle(send)).rejects.toThrow('This run id has already been used.');
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('sends captured attachments with their source revision and position', async () => {
      const harness = await fixture(async () => {});
      try {
        const range = { start: { line: 2, column: 1 }, end: { line: 3, column: 1 } };
        const capture = {
          kind: GlyphContextAttachmentKind.SELECTION,
          uri: 'file:///project/a.ts',
          path: 'a.ts',
          text: 'abc',
          contentRevision: 'content',
        };
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Inspect',
          attachments: [
            {
              ...capture,
              token: { workspaceGeneration: 'g', resource: capture.uri, incarnation: 'i', version: 7 },
              sourceVersion: 5,
              sourceRevision: 'source',
              range,
              side: 'modified',
            },
            { ...capture, path: 'b.ts', sourceVersion: 4 },
            { ...capture, path: 'c.ts', kind: GlyphContextAttachmentKind.FILE },
          ],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect((await harness.runtime.snapshot()).runs[0]?.attachments).toEqual([
          { uri: capture.uri, path: 'a.ts', text: 'abc', revision: 'content', range, side: 'modified' },
          { uri: capture.uri, path: 'b.ts', text: 'abc', revision: 'content' },
          { uri: capture.uri, path: 'c.ts', text: 'abc', revision: 'content' },
        ]);
        expect(harness.saved.get(harness.chatId)?.transcript[0]?.attachments?.map(value => value.source)).toEqual([
          { kind: 'selection', uri: capture.uri, version: 7, revision: 'source', range, side: 'modified' },
          { kind: 'selection', uri: capture.uri, version: 4, revision: 'content' },
          { kind: 'file', uri: capture.uri, version: 0, revision: 'content' },
        ]);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('counts a turn whose usage was only partly reported', async () => {
      const partial = { ...usage, incomplete: true };
      const harness = await fixture(async () => partial);
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Count',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect((await harness.runtime.snapshot()).runs[0]?.usage).toEqual({ ...partial, unreportedTurns: 1 });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('reports non-error provider failures as redacted text', async () => {
      const harness = await fixture(async () => {
        throw 'secret outage';
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Fail',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
            status: GlyphRunStatus.FAILED,
            terminalMessage: '[REDACTED] outage',
          });
        });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('streams diagnostics separately from the answer', async () => {
      const harness = await fixture(async () => {});
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      try {
        vi.spyOn(ChatSession.prototype, 'send').mockImplementationOnce(async (_request, response) => {
          response.push({
            type: ChatResponsePartType.DIAGNOSTIC,
            severity: DiagnosticSeverity.ERROR,
            message: 'Trace failed',
          });
          response.push({ type: ChatResponsePartType.TEXT, value: 'Answer' });
          return { usage: null, responseId: 'response', durationMs: 0 };
        });
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Go',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect(harness.events).toContainEqual({
          type: GlyphHostEventType.RESPONSE_DELTA,
          chatId: harness.chatId,
          runId: 'run',
          delta: { kind: GlyphResponseDeltaKind.DIAGNOSTIC, value: 'Trace failed' },
        });
        const run = (await harness.runtime.snapshot()).runs[0]!;
        expect(run).toMatchObject({ text: 'Answer', reasoning: '' });
        expect(run).not.toHaveProperty('checkpointTurnId');
        expect(run).not.toHaveProperty('usage');
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('keeps the saved timestamp of a legacy turn that already used the run id', async () => {
      const record = chatRecord({
        transcript: [
          {
            userText: 'Legacy',
            attachmentPaths: [],
            assistantText: 'Old',
            reasoningSummary: '',
            createdAt: '2026-09-01T00:00:00.000Z',
            options: { turnId: 'legacy-run' },
          },
        ],
      });
      const harness = await fixture(async () => {}, 'owner', undefined, { records: [record] });
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      try {
        vi.spyOn(ChatSession.prototype, 'send').mockResolvedValueOnce({
          usage: null,
          responseId: 'response',
          durationMs: 0,
        });
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: record.id,
          runId: 'legacy-run',
          text: 'Again',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs.find(run => run.runId === 'legacy-run')?.status).toBe(
            GlyphRunStatus.COMPLETED,
          );
        });
        const run = (await harness.runtime.snapshot()).runs.find(value => value.runId === 'legacy-run')!;
        expect(run.createdAt).toBe('2026-09-01T00:00:00.000Z');
        expect(run).not.toHaveProperty('checkpointTurnId');
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('validates steering text and context size before accepting it', async () => {
      const gate = deferredVoid();
      const entered = deferredVoid();
      const harness = await fixture(async options => {
        entered.resolve();
        await gate.promise;
        options.takeSteering?.(true);
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Start',
          attachments: [],
        });
        await entered.promise;
        const steer = { type: Command.STEER, chatId: harness.chatId, runId: 'run', messageId: 'steer' } as const;
        const capture = {
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///project/a.ts',
          path: 'a.ts',
          text: 'abc',
          contentRevision: 'r1',
        };
        await expect(harness.runtime.handle({ ...steer, text: '   ', attachments: [] })).rejects.toThrow(
          'Steering instructions cannot be empty.',
        );
        await expect(
          harness.runtime.handle({ ...steer, text: 'More', attachments: Array.from({ length: 33 }, () => capture) }),
        ).rejects.toThrow('Reduce the selected context to at most 32 attachments and 2 MiB.');
        await expect(
          harness.runtime.handle({
            ...steer,
            text: 'More',
            attachments: [{ ...capture, text: 'x'.repeat(2 * 1024 * 1024 + 1) }],
          }),
        ).rejects.toThrow('Reduce the selected context to at most 32 attachments and 2 MiB.');
        const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
        await harness.runtime.handle({
          ...steer,
          text: 'More',
          attachments: [{ ...capture, range, side: 'original' }, capture],
        });
        expect((await harness.runtime.snapshot()).runs[0]?.steering?.[0]?.attachments).toEqual([
          { uri: capture.uri, path: 'a.ts', text: 'abc', revision: 'r1', range, side: 'original' },
          { uri: capture.uri, path: 'a.ts', text: 'abc', revision: 'r1' },
        ]);
      } finally {
        gate.resolve();
        await harness.runtime.dispose();
      }
    });

    it('ignores a cancellation aimed at a different run', async () => {
      const gate = deferredVoid();
      const entered = deferredVoid();
      const harness = await fixture(async options => {
        entered.resolve();
        await gate.promise;
        expect(options.signal.aborted).toBe(false);
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Keep going',
          attachments: [],
        });
        await entered.promise;
        await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'another' });
        gate.resolve();
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
      } finally {
        gate.resolve();
        await harness.runtime.dispose();
      }
    });

    it('records free-text answers to model questions', async () => {
      const harness = await fixture(async (options, interactions) => {
        await interactions.present(
          {
            questions: [
              { id: 'why', prompt: 'Why?', allowMultiple: false, options: [{ id: 'because', label: 'Because' }] },
            ],
          },
          options.signal,
        );
        options.onText('Thanks');
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Ask',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_QUESTION);
        });
        const question = (await harness.runtime.snapshot()).runs[0]!.question!;
        await harness.runtime.handle({
          type: Command.ANSWER_QUESTION,
          chatId: harness.chatId,
          runId: 'run',
          questionId: question.id,
          answer: { answers: [{ questionId: 'why', type: QuestionAnswerType.OTHER, text: '  It matters  ' }] },
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect((await harness.runtime.snapshot()).runs[0]?.questionResponses).toEqual([
          { id: question.id, answers: [{ question: 'Why?', answer: 'It matters' }] },
        ]);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('resumes a run once its approval is decided', async () => {
      const harness = await fixture(async (options, interactions) => {
        options.onText(
          await interactions.presentShellPermission({ command: 'ls', workingDirectory: '/project' }, options.signal),
        );
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'List',
          attachments: [],
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
        });
        const approval = (await harness.runtime.snapshot()).runs[0]!.approval!;
        await harness.runtime.handle({
          type: Command.DECIDE_APPROVAL,
          chatId: harness.chatId,
          runId: 'run',
          approvalId: approval.id,
          decision: GlyphApprovalDecision.ALLOW_ONCE,
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
            status: GlyphRunStatus.COMPLETED,
            text: 'allow_once',
          });
        });
        expect((await harness.runtime.snapshot()).runs[0]?.approval).toBeUndefined();
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('relays decisions requested outside any tracked run without inventing one', async () => {
      const harness = await fixture(async () => {});
      try {
        const decision = harness.interactions.run({ chatId: harness.chatId, runId: 'external' }, () =>
          harness.interactions.presentShellPermission(
            { command: 'ls', workingDirectory: '/project' },
            new AbortController().signal,
          ),
        );
        const approval = harness.events.find(event => event.type === GlyphHostEventType.APPROVAL);
        if (approval?.type !== GlyphHostEventType.APPROVAL) throw new Error('The approval was not relayed.');
        expect(approval.runId).toBe('external');
        await harness.runtime.handle({
          type: Command.DECIDE_APPROVAL,
          chatId: harness.chatId,
          runId: 'external',
          approvalId: approval.approval.id,
          decision: GlyphApprovalDecision.DENY,
        });
        await expect(decision).resolves.toBe('deny');
        expect((await harness.runtime.snapshot()).runs).toEqual([]);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('forwards bounded shell input to the owning chat terminal', async () => {
      const harness = await fixture(async () => {});
      try {
        const write = {
          type: Command.WRITE_SHELL_INPUT,
          chatId: harness.chatId,
          sessionId: 'terminal',
          appendNewline: true,
        } as const;
        await expect(harness.runtime.handle({ ...write, input: 'x'.repeat(64 * 1024 + 1) })).rejects.toThrow(
          'Shell input exceeds 64 KiB.',
        );
        await harness.runtime.handle({ ...write, input: 'yes' });
        expect(harness.shells.writeInput).toHaveBeenCalledExactlyOnceWith({
          terminalId: 'terminal',
          input: 'yes',
          appendNewline: true,
          ownerChatId: harness.chatId,
          signal: expect.any(AbortSignal),
        });
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('previews a proposal file only for the chat and account that created it', async () => {
      const { reviews, stage } = reviewFixture();
      const harness = await fixture(async () => {}, 'owner', reviews);
      try {
        const staged = await stage(harness.chatId);
        const file = reviews.get(staged.proposalId)!.files[0]!;
        const read = {
          type: Command.READ_PROPOSAL_FILE,
          chatId: harness.chatId,
          proposalId: staged.proposalId,
          fileId: file.id,
        } as const;
        await harness.runtime.handle(read);
        expect(harness.events.at(-1)).toEqual({
          type: GlyphHostEventType.PROPOSAL_PREVIEW,
          preview: toGlyphProposalFilePreview(staged.proposalId, file),
        });
        await expect(harness.runtime.handle({ ...read, fileId: 'missing' })).rejects.toThrow(
          'This proposal file is no longer available.',
        );
        for (const origin of [{ accountId: 'other' }, { accountProvider: 'other' }]) {
          const foreign = await stage(harness.chatId, true, origin, `${Object.values(origin)[0]}.txt`);
          await expect(
            harness.runtime.handle({ ...read, proposalId: foreign.proposalId, fileId: foreign.itemId }),
          ).rejects.toThrow('This proposal does not belong to that chat.');
        }
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('accepts proposal items only for the chat that created them', async () => {
      const { reviews, stage } = reviewFixture();
      const harness = await fixture(async () => {}, 'owner', reviews);
      try {
        const staged = await stage(harness.chatId);
        const accept = vi.spyOn(reviews, 'acceptInReview').mockResolvedValue();
        const command = {
          type: Command.ACCEPT_PROPOSAL_ITEM,
          chatId: harness.chatId,
          proposalId: staged.proposalId,
          itemId: staged.itemId,
        } as const;
        await expect(harness.runtime.handle({ ...command, proposalId: 'missing' })).rejects.toThrow(
          'This proposal does not belong to that chat.',
        );
        await harness.runtime.handle(command);
        expect(accept).toHaveBeenCalledExactlyOnceWith(staged.proposalId, staged.itemId);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('refuses proposal decisions when the workspace has no reviews', async () => {
      const harness = await fixture(async () => {});
      try {
        await expect(
          harness.runtime.handle({
            type: Command.REJECT_PROPOSAL_ITEM,
            chatId: harness.chatId,
            proposalId: 'proposal',
            itemId: 'item',
          }),
        ).rejects.toThrow('This proposal does not belong to that chat.');
      } finally {
        await harness.runtime.dispose();
      }
    });
  });

  describe(ProviderDesktopRuntime.prototype.publish, () => {
    it('tracks requested mode switches on their run until each is settled', async () => {
      const harness = await fixture(async (options, interactions) => {
        for (const description of ['First', 'Second'])
          await interactions.presentModeSwitch(
            { source: AgentModeID.PLAN, target: AgentModeID.AGENT, description },
            options.signal,
            async () => {},
            (id, status) => {
              harness.runtime.finishModeSwap(harness.chatId, id, status);
            },
          );
        options.onText('Switched');
      });
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'run',
          text: 'Plan then build',
          attachments: [],
        });
        const pendingApproval = async () => {
          await vi.waitFor(async () => {
            expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
          });
          return (await harness.runtime.snapshot()).runs[0]!.approval!;
        };
        const first = await pendingApproval();
        await harness.runtime.handle({
          type: Command.DECIDE_APPROVAL,
          chatId: harness.chatId,
          runId: 'run',
          approvalId: first.id,
          decision: GlyphApprovalDecision.DENY,
        });
        const second = await pendingApproval();
        expect((await harness.runtime.snapshot()).runs[0]?.modeSwaps?.map(swap => [swap.id, swap.status])).toEqual([
          [first.id, GlyphModeSwapStatus.DENIED],
          [second.id, GlyphModeSwapStatus.PENDING],
        ]);
        harness.runtime.finishModeSwap('another-chat', second.id, GlyphModeSwapStatus.CANCELLED);
        harness.runtime.finishModeSwap(harness.chatId, 'unknown', GlyphModeSwapStatus.CANCELLED);
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
        harness.runtime.finishModeSwap(harness.chatId, second.id, GlyphModeSwapStatus.CANCELLED);
        expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({ status: GlyphRunStatus.STREAMING });
        expect((await harness.runtime.snapshot()).runs[0]?.approval).toBeUndefined();
        await harness.runtime.handle({
          type: Command.DECIDE_APPROVAL,
          chatId: harness.chatId,
          runId: 'run',
          approvalId: second.id,
          decision: GlyphApprovalDecision.ALLOW_ONCE,
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect((await harness.runtime.snapshot()).runs[0]?.modeSwaps?.map(swap => swap.status)).toEqual([
          GlyphModeSwapStatus.DENIED,
          GlyphModeSwapStatus.APPROVED,
        ]);
      } finally {
        await harness.runtime.dispose();
      }
    });
  });

  describe(ProviderDesktopRuntime.prototype.snapshot, () => {
    it('summarizes automatic changes, renames, deletions, and unknown review states', async () => {
      const { reviews } = reviewFixture();
      const harness = await fixture(async () => {}, 'owner', reviews);
      try {
        const text = (value: string) => ({
          path: 'file.ts',
          identity: 'file.ts',
          text: value,
          byteOrderMark: false,
          revision: value,
          byteLength: value.length,
          mode: 0o644,
        });
        const plan = (overrides: Partial<FileEditPlanRecord>): FileEditPlan =>
          FileEditPlan.from({
            id: 'file',
            operation: EditOperation.UPDATE,
            sourcePath: 'file.ts',
            targetPath: 'file.ts',
            base: text('base'),
            current: text('current'),
            proposed: text('proposed'),
            items: [],
            applyingItemId: null,
            createdDirectories: [],
            applicability: EditApplicabilityState.READY,
            currentPath: 'file.ts',
            currentRevision: 'current',
            ...overrides,
          });
        vi.spyOn(reviews, 'retainedReviews', 'get').mockReturnValue([
          EditProposal.from({
            schemaVersion: 1,
            id: 'proposal',
            source: 'structured',
            createdAt: '2026-10-01T00:00:00.000Z',
            files: [
              plan({
                id: 'renamed',
                operation: EditOperation.RENAME,
                targetPath: 'new.ts',
                currentPath: 'old.ts',
                automatic: {
                  itemId: 'rename',
                  before: text('1\n2\n3\n4\n5\n6\n7\n8'),
                  state: 'applied',
                  appliedRevision: 'current',
                },
                items: [
                  {
                    id: 'rename',
                    fileId: 'renamed',
                    kind: EditReviewItemKind.RENAME,
                    sourceStart: 0,
                    sourceEnd: 0,
                    removedText: 'old\n',
                    insertedText: 'new\nlines\n',
                    decision: EditDecisionState.PENDING,
                  },
                ],
              }),
              plan({
                id: 'deleted',
                operation: EditOperation.DELETE,
                current: null,
                automatic: { itemId: 'delete', before: null, state: 'reverting', appliedRevision: null },
                applicability: 'UNKNOWN' as EditApplicabilityState,
              }),
              plan({
                id: 'created',
                operation: EditOperation.CREATE,
                current: null,
                automatic: { itemId: 'create', before: null, state: 'kept', appliedRevision: null },
                applicability: EditApplicabilityState.FAILED_RETRYABLE,
              }),
            ],
          }),
        ]);
        expect((await harness.runtime.snapshot()).proposals).toEqual([
          {
            id: 'proposal',
            createdAt: '2026-10-01T00:00:00.000Z',
            files: [
              {
                id: 'renamed',
                path: 'new.ts',
                operation: EditOperation.RENAME,
                sourcePath: 'file.ts',
                automaticItemId: 'rename',
                autoApplied: true,
                beforePreview: '1\n2\n3\n4\n5\n6',
                afterPreview: 'current',
                proposedUri: 'glyph-proposal:/proposal/renamed',
                textOnly: false,
                additions: 2,
                deletions: 1,
                pendingItemIds: ['rename'],
                applicability: 'ready',
              },
              {
                id: 'deleted',
                path: 'file.ts',
                operation: EditOperation.DELETE,
                sourcePath: 'file.ts',
                automaticItemId: 'delete',
                autoApplied: true,
                beforePreview: '',
                afterPreview: '',
                proposedUri: 'glyph-proposal:/proposal/deleted',
                textOnly: false,
                additions: 0,
                deletions: 0,
                pendingItemIds: [],
                applicability: 'stale',
              },
              {
                id: 'created',
                path: 'file.ts',
                operation: EditOperation.CREATE,
                sourcePath: 'file.ts',
                automaticItemId: 'create',
                autoApplied: false,
                beforePreview: '',
                afterPreview: 'proposed',
                proposedUri: 'glyph-proposal:/proposal/created',
                textOnly: false,
                additions: 0,
                deletions: 0,
                pendingItemIds: [],
                applicability: 'failed_retryable',
              },
            ],
          },
        ]);
      } finally {
        await harness.runtime.dispose();
      }
    });

    it('ignores change notices for reviews it has never seen', async () => {
      const { reviews } = reviewFixture();
      const listen = vi.spyOn(reviews, 'onDidChange');
      const harness = await fixture(async () => {}, 'owner', reviews);
      try {
        const before = harness.events.length;
        listen.mock.lastCall![0]({
          type: ProposalReviewChangeType.DECISION,
          proposalIds: ['missing'],
          pendingChangeCount: 0,
        });
        expect(harness.events).toHaveLength(before);
      } finally {
        await harness.runtime.dispose();
      }
    });
  });

  describe(ProviderDesktopRuntime.prototype.dispose, () => {
    it('reports a dependency that fails to stop after finishing teardown', async () => {
      const harness = await fixture(async () => {});
      const glyph = vi.spyOn(harness.glyph, 'dispose');
      harness.shells.dispose.mockRejectedValueOnce(new Error('Shell stuck'));
      await expect(harness.runtime.dispose()).rejects.toThrow('Shell stuck');
      expect(glyph).toHaveBeenCalledOnce();
    });
  });

  it('publishes agent review changes and includes reviews in snapshots', async () => {
    const agentReviews = agentReviewsFake();
    const harness = await fixture(async () => {}, 'owner', undefined, { agentReviews: agentReviews.service });
    try {
      const review = agentReview();
      agentReviews.reviews.push(review);
      agentReviews.change(review);
      expect(harness.events.at(-1)).toEqual({ type: GlyphHostEventType.AGENT_REVIEW_CHANGED, review });
      expect((await harness.runtime.snapshot()).agentReviews).toEqual([review]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('projects live shell state onto the tool calls that started it', async () => {
    let calls = 0;
    const harness = await fixture(async options => {
      if (++calls > 1) return;
      const execute = (callId: string, phase: ToolActivityPhase, input: object, output?: object) =>
        options.onToolActivity?.({
          phase,
          namespace: 'shell',
          name: 'execute_shell',
          callId,
          ...(callId === 'broken' ? {} : { executionId: `${callId}-execution` }),
          arguments: JSON.stringify(input),
          ...(output ? { output: JSON.stringify(output) } : {}),
        });
      options.onToolActivity?.({ phase: ToolActivityPhase.COMPLETED, name: 'read', callId: 'read', arguments: '{}' });
      execute('server', ToolActivityPhase.STARTED, { command: 'npm start', background: true });
      execute(
        'server',
        ToolActivityPhase.COMPLETED,
        { command: 'npm start', background: true },
        { terminal_id: 'terminal', output: 'started' },
      );
      execute('broken', ToolActivityPhase.STARTED, { command: 'false' });
      execute('broken', ToolActivityPhase.COMPLETED, { command: 'false' }, { error: { message: 'secret failure' } });
      execute('worker', ToolActivityPhase.STARTED, { command: 'make', background: true });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Start the server',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect((await harness.runtime.snapshot()).runs[0]?.tools.map(tool => [tool.id, tool.status, tool.shell])).toEqual(
        [
          ['read', GlyphToolActivityStatus.COMPLETED, undefined],
          [
            'server',
            GlyphToolActivityStatus.COMPLETED,
            {
              command: 'npm start',
              output: '',
              background: true,
              sessionId: 'terminal',
              live: false,
              running: false,
            },
          ],
          [
            'broken',
            GlyphToolActivityStatus.FAILED,
            {
              command: 'false',
              output: '',
              background: false,
              error: '[REDACTED] failure',
              live: false,
              running: false,
            },
          ],
          [
            'worker',
            GlyphToolActivityStatus.STARTED,
            { command: 'make', output: '', background: true, live: false, running: false },
          ],
        ],
      );
      const terminal: ShellSessionSnapshot = {
        id: 'terminal',
        executionId: 'server-execution',
        ownerChatId: harness.chatId,
        command: 'npm start',
        workingDirectory: '/project',
        status: ShellSessionStatus.RUNNING,
        background: true,
        outputTail: 'listening',
        startedAt: 'now',
        error: 'secret warning',
        wakePattern: 'READY secret',
        exitCode: 1,
      };
      const unrelated: ShellSessionSnapshot = {
        id: 'unrelated',
        ownerChatId: harness.chatId,
        command: 'watch',
        workingDirectory: '/project',
        status: ShellSessionStatus.RUNNING,
        background: true,
        outputTail: '',
        startedAt: 'now',
      };
      const worker: ShellSessionSnapshot = {
        id: 'worker-terminal',
        executionId: 'worker-execution',
        ownerChatId: harness.chatId,
        command: 'make',
        workingDirectory: '/project',
        status: ShellSessionStatus.IDLE,
        background: false,
        outputTail: 'built',
        startedAt: 'now',
        exitCode: 0,
      };
      harness.shells.allSessions = [terminal, unrelated, worker];
      harness.emitShells();
      expect((await harness.runtime.snapshot()).runs[0]?.tools.find(tool => tool.id === 'worker')).toMatchObject({
        status: GlyphToolActivityStatus.STARTED,
        shell: { output: 'built', exitCode: 0, live: false, running: false },
      });
      const server = (await harness.runtime.snapshot()).runs[0]?.tools.find(tool => tool.id === 'server');
      expect(server).toMatchObject({
        status: GlyphToolActivityStatus.FAILED,
        shell: {
          command: 'npm start',
          output: 'listening',
          workingDirectory: '/project',
          sessionId: 'terminal',
          error: '[REDACTED] warning',
          wakePattern: 'READY [REDACTED]',
          background: true,
          live: true,
          running: true,
          exitCode: 1,
        },
      });
      expect((await harness.runtime.snapshot()).shells).toContainEqual({
        id: 'terminal',
        chatId: harness.chatId,
        command: 'npm start',
        workingDirectory: '/project',
        output: 'listening',
        running: true,
        error: '[REDACTED] warning',
        exitCode: 1,
        wakePattern: 'READY [REDACTED]',
      });
      const { error: _error, ...recovered } = terminal;
      harness.shells.allSessions = [
        { ...recovered, status: ShellSessionStatus.EXITED, exitCode: 2 },
        { ...unrelated, status: ShellSessionStatus.EXITED, exitCode: 0 },
      ];
      harness.emitShells();
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.map(run => run.userText)).toEqual([
          'Start the server',
          'Exited npm start',
          'Finished watch',
        ]);
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('ignores shell wake conditions that belong to no chat in this workspace', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    try {
      harness.wake({
        id: 'wake',
        terminalId: 'terminal',
        pattern: 'READY',
        command: 'server',
        workingDirectory: '/project',
        output: 'READY',
        matchedAt: 'now',
      });
      harness.wake({
        id: 'ghost-wake',
        terminalId: 'terminal',
        ownerChatId: 'ghost-chat',
        pattern: 'READY',
        command: 'server',
        workingDirectory: '/project',
        output: 'READY',
        matchedAt: 'now',
      });
      expect((await harness.runtime.snapshot()).runs).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('abandons a shell wake whose terminal closed while its context was being saved', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    const gate = deferredVoid();
    const save = harness.store.save.bind(harness.store);
    try {
      const saving = vi.spyOn(harness.store, 'save').mockImplementationOnce(async record => {
        await gate.promise;
        await save(record);
      });
      harness.wake({
        id: 'wake-1',
        terminalId: 'terminal',
        ownerChatId: harness.chatId,
        pattern: 'READY',
        command: 'server',
        workingDirectory: '/project',
        output: 'READY\n',
        matchedAt: 'now',
      });
      await vi.waitFor(() => {
        expect(saving).toHaveBeenCalledOnce();
      });
      harness.shells.takePendingWake('wake-1');
      gate.resolve();
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
          status: GlyphRunStatus.FAILED,
          terminalMessage: 'The shell wake was revoked because its terminal closed.',
        });
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });
});

function agentReviewInput(): AgentReviewInput {
  return {
    id: 'review',
    repositoryUri: 'file:///project',
    scope: AgentReviewScope.STAGED,
    branch: '',
    label: 'Staged changes',
    files: [],
  };
}

function agentReview(): AgentReview {
  return {
    ...agentReviewInput(),
    accountProvider: 'fixture',
    accountId: 'account',
    model: 'model',
    status: AgentReviewStatus.COMPLETED,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    findings: [],
    dismissedIds: [],
    summary: 'No findings',
  };
}

function agentReviewsFake() {
  const listeners = new Set<(review: AgentReview) => void>();
  const fake = {
    reviews: [] as AgentReview[],
    onDidChange: (listener: (review: AgentReview) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: vi.fn(async (_input: AgentReviewInput, _model: AgentReviewModel) => {}),
    cancel: vi.fn(async (_id: string) => {}),
    dismiss: vi.fn(async (_id: string, _findingId: string) => {}),
    dispose: vi.fn(async () => {}),
  };
  return {
    ...fake,
    service: fake as unknown as AgentReviewService,
    change: (review: AgentReview) => {
      for (const listener of listeners) listener(review);
    },
  };
}

function chatRecord(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
  return {
    schemaVersion: 3,
    id: 'saved-chat',
    title: 'Saved chat',
    titleOrigin: 'human',
    projectContextId: 'project',
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'model',
    modelName: 'Model',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    providerState: { provider: 'fixture', version: 1, data: [] },
    transcript: [],
    ...overrides,
  };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const wakeFor = (chatId: string): ShellWakeEvent => ({
  id: 'wake-1',
  terminalId: 'terminal',
  ownerChatId: chatId,
  pattern: 'READY',
  command: 'server',
  workingDirectory: '/project',
  output: 'READY\n',
  matchedAt: new Date().toISOString(),
});

describe('background shell continuation scheduling', () => {
  it('persists matching output before exactly one continuation and keeps the owning chat', async () => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
      expect(harness.recorded.flat()).toContainEqual(
        expect.objectContaining({ type: 'shell_wake', payload: expect.objectContaining({ output: 'READY\n' }) }),
      );
    });
    try {
      const wake = wakeFor(harness.chatId);
      harness.wake(wake);
      harness.wake(wake);
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      harness.wake(wake);
      await harness.runtime.snapshot();
      expect(sends).toBe(1);
      expect(harness.recorded.flat()).toHaveLength(1);
      expect((await harness.runtime.snapshot()).runs[0]?.chatId).toBe(harness.chatId);
    } finally {
      await harness.runtime.dispose();
    }
  });
  it('waits for an active turn and reserves the turn lock while saving the wake', async () => {
    const gate = deferredVoid();
    let sends = 0;
    const harness = await fixture(async () => {
      if (++sends === 1) await gate.promise;
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });
      harness.wake(wakeFor(harness.chatId));
      expect(harness.recorded.flat()).toHaveLength(0);
      gate.resolve();
      await vi.waitFor(() => {
        expect(sends).toBe(2);
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect(harness.recorded.flat()).toHaveLength(1);
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });
  it('holds the chat turn lock while wake persistence is still pending', async () => {
    const gate = deferredVoid();
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    const save = harness.store.save.bind(harness.store);
    try {
      const saving = vi.spyOn(harness.store, 'save').mockImplementation(async record => {
        await gate.promise;
        await save(record);
      });
      harness.wake(wakeFor(harness.chatId));
      await vi.waitFor(() => {
        expect(saving).toHaveBeenCalled();
      });
      await expect(
        harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'racing',
          text: 'Race',
          attachments: [],
        }),
      ).rejects.toThrow('active run');
      expect(sends).toBe(0);
      gate.resolve();
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });
  it('does not consume or invoke the provider when durable context storage fails', async () => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    try {
      vi.spyOn(harness.store, 'save').mockRejectedValue(new Error('Disk unavailable'));
      harness.wake(wakeFor(harness.chatId));
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.FAILED);
      });
      expect(sends).toBe(0);
      expect(harness.shells.peekPendingWake(() => true)?.id).toBe('wake-1');
    } finally {
      await harness.runtime.dispose();
    }
  });
  it.each(['wake', 'exit'] as const)(
    'retries an unacknowledged shell %s after storage recovers without looping on a failed checkpoint',
    async kind => {
      const send = vi.fn(async () => {});
      const harness = await fixture(send);
      const save = harness.store.save.bind(harness.store);
      try {
        const saving = vi.spyOn(harness.store, 'save').mockRejectedValue(new Error('Disk unavailable'));
        if (kind === 'wake') {
          harness.wake(wakeFor(harness.chatId));
        } else {
          const shell: ShellSessionSnapshot = {
            id: 'terminal',
            ownerChatId: harness.chatId,
            command: 'server',
            workingDirectory: '/project',
            outputTail: 'final output',
            startedAt: 'now',
            background: true,
            status: ShellSessionStatus.RUNNING,
          };
          harness.shells.allSessions = [shell];
          harness.emitShells();
          harness.shells.allSessions = [{ ...shell, status: ShellSessionStatus.EXITED, exitCode: 0 }];
          harness.emitShells();
        }
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.FAILED);
        });
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
        expect(saving).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(harness.recorded.flat()).toEqual([]);
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId }, { windowId: 'peer' });
        expect(saving).toHaveBeenCalledTimes(1);
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
        await vi.waitFor(() => {
          expect(saving).toHaveBeenCalledTimes(2);
        });
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
        expect(saving).toHaveBeenCalledTimes(2);
        expect(send).not.toHaveBeenCalled();
        saving.mockImplementation(save);
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(harness.recorded.flat()).toEqual([expect.objectContaining({ type: `shell_${kind}` })]);
        expect(harness.shells.peekPendingWake(() => true)).toBeUndefined();
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        await harness.runtime.dispose();
      }
    },
  );
  it('does not retry a shell continuation after its context was acknowledged and the provider failed', async () => {
    const send = vi.fn(async () => {
      throw new Error('Provider unavailable');
    });
    const harness = await fixture(send);
    try {
      const wake = wakeFor(harness.chatId);
      harness.wake(wake);
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.FAILED);
      });
      expect(harness.shells.peekPendingWake(() => true)).toBeUndefined();
      harness.wake(wake);
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      expect(send).toHaveBeenCalledTimes(1);
      expect(harness.recorded.flat()).toHaveLength(1);
    } finally {
      await harness.runtime.dispose();
    }
  });
  it('resumes an unacknowledged wake after a disconnect during its checkpoint without duplicating context', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    const gate = deferredVoid();
    const save = harness.store.save.bind(harness.store);
    try {
      const saving = vi.spyOn(harness.store, 'save').mockImplementationOnce(async record => {
        await gate.promise;
        await save(record);
      });
      harness.wake(wakeFor(harness.chatId));
      await vi.waitFor(() => {
        expect(saving).toHaveBeenCalledTimes(1);
      });
      const disconnected = harness.runtime.connectionLost('owner');
      gate.resolve();
      await disconnected;
      expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
      expect(send).not.toHaveBeenCalled();
      expect(harness.shells.peekPendingWake(() => true)?.id).toBe('wake-1');
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(harness.recorded.flat()).toHaveLength(1);
      expect(harness.shells.peekPendingWake(() => true)).toBeUndefined();
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });
  it('revokes a pending closed-shell match and reports the stopped command with final output once', async () => {
    const gate = deferredVoid();
    let sends = 0;
    const harness = await fixture(async () => {
      if (++sends === 1) await gate.promise;
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });
      const shell: ShellSessionSnapshot = {
        id: 'terminal',
        ownerChatId: harness.chatId,
        command: 'server',
        workingDirectory: '/project',
        outputTail: 'last line',
        startedAt: 'now',
        background: true,
        status: ShellSessionStatus.RUNNING,
      };
      harness.shells.allSessions = [shell];
      harness.emitShells();
      harness.wake(wakeFor(harness.chatId));
      harness.shells.close.mockImplementation(async () => {
        harness.shells.takePendingWake('wake-1');
        harness.shells.allSessions = [
          { ...shell, status: ShellSessionStatus.IDLE, outputTail: 'final output', exitCode: 128 },
        ];
        harness.emitShells();
        harness.shells.allSessions = [];
        harness.emitShells();
      });
      await harness.runtime.handle({ type: Command.STOP_SHELL_SESSION, chatId: harness.chatId, sessionId: 'terminal' });
      gate.resolve();
      await vi.waitFor(() => {
        expect(sends).toBe(2);
      });
      expect(harness.recorded.flat()).toEqual([
        expect.objectContaining({
          type: 'shell_exit',
          payload: expect.objectContaining({ outputTail: 'final output', reason: 'stopped' }),
        }),
      ]);
      expect((await harness.runtime.snapshot()).runs.at(-1)?.userText).toBe('Stopped server');
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });
  it('delivers an asynchronous launch failure as a failed background command with its actual error', async () => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    try {
      const shell: ShellSessionSnapshot = {
        id: 'terminal',
        ownerChatId: harness.chatId,
        command: 'server',
        workingDirectory: '/project',
        outputTail: '',
        startedAt: 'now',
        background: true,
        status: ShellSessionStatus.RUNNING,
      };
      harness.shells.allSessions = [shell];
      harness.emitShells();
      harness.shells.allSessions = [{ ...shell, status: ShellSessionStatus.EXITED, error: 'spawn ENOENT' }];
      harness.emitShells();
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });
      expect((await harness.runtime.snapshot()).shells?.[0]).toMatchObject({ running: false, error: 'spawn ENOENT' });
      expect((await harness.runtime.snapshot()).runs.at(-1)?.userText).toBe('Failed server');
      expect(harness.recorded.flat()).toContainEqual(
        expect.objectContaining({ type: 'shell_exit', payload: expect.objectContaining({ error: 'spawn ENOENT' }) }),
      );
    } finally {
      await harness.runtime.dispose();
    }
  });
  it('defers notifications while disconnected and resumes them only after an owner command', async () => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    try {
      await harness.runtime.connectionLost('owner');
      harness.wake(wakeFor(harness.chatId));
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId }, { windowId: 'peer' });
      await harness.runtime.snapshot();
      expect(sends).toBe(0);
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });
    } finally {
      await harness.runtime.dispose();
    }
  });
});

describe('goal continuation', () => {
  const goalOf = async (runtime: ProviderDesktopRuntime, chatId: string) =>
    (await runtime.snapshot()).chats.find(chat => chat.id === chatId)?.goal;

  it('can complete an idle goal without an active provider turn', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const chat = harness.glyph.listChats().find(value => value.id === harness.chatId)!;
      await expect(harness.runtime.updateGoalFromTool(chat, GoalStatus.COMPLETE)).resolves.toMatchObject({
        status: 'complete',
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('does not start a continuation until its counter is durably saved', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      const saving = vi.spyOn(harness.glyph, 'updateGoal').mockRejectedValueOnce(new Error('Disk unavailable'));
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(saving).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await goalOf(harness.runtime, harness.chatId)).toEqual(goal);
      saving.mockRestore();
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledOnce();
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('does not reuse a continuation run id already claimed by a client', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: `goal-continuation:${goal.id}:1`,
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      expect(send).toHaveBeenCalledOnce();
      expect((await goalOf(harness.runtime, harness.chatId))?.continuationCount).toBe(0);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('holds continuations while a checkpoint is being restored', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    const gate = deferredVoid();
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'human',
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      const restore = vi.spyOn(ChatSession.prototype, 'restoreCheckpoint').mockImplementationOnce(async () => {
        await gate.promise;
      });
      const restoring = harness.runtime.handle({
        type: Command.RESTORE_CHECKPOINT,
        chatId: harness.chatId,
        turnId: 'human',
      });
      await vi.waitFor(() => {
        expect(restore).toHaveBeenCalledOnce();
      });
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      expect(send).toHaveBeenCalledOnce();
      gate.resolve();
      await restoring;
      restore.mockRestore();
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });

  it('holds continuations behind a shell event whose durable context failed to save', async () => {
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      const saving = vi.spyOn(harness.store, 'save').mockRejectedValue(new Error('Disk unavailable'));
      harness.wake(wakeFor(harness.chatId));
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.FAILED);
      });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      await harness.runtime.handle(
        { type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id },
        { windowId: 'peer' },
      );
      expect(send).not.toHaveBeenCalled();
      expect((await goalOf(harness.runtime, harness.chatId))?.continuationCount).toBe(0);
      saving.mockRestore();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it.each(['paused', 'replaced'] as const)(
    'preserves a goal %s while the previous run waits to settle',
    async change => {
      const gate = deferredVoid();
      const entered = deferredVoid();
      const harness = await fixture(async () => {});
      try {
        await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'First' });
        const goal = (await goalOf(harness.runtime, harness.chatId))!;
        const update = harness.glyph.updateGoal.bind(harness.glyph);
        const saving = vi
          .spyOn(harness.glyph, 'updateGoal')
          .mockImplementationOnce(update)
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await gate.promise;
            return update(...args);
          });
        await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
        await entered.promise;
        if (change === 'paused')
          await harness.runtime.handle({ type: Command.PAUSE_GOAL, chatId: harness.chatId, goalId: goal.id });
        else {
          await harness.runtime.handle({ type: Command.CLEAR_GOAL, chatId: harness.chatId, goalId: goal.id });
          await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Second' });
        }
        const current = await goalOf(harness.runtime, harness.chatId);
        gate.resolve();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
        expect(await goalOf(harness.runtime, harness.chatId)).toEqual(current);
        saving.mockRestore();
      } finally {
        gate.resolve();
        await harness.runtime.dispose();
      }
    },
  );

  it('uses the normalized chat mode and treats absent tool history as idle', async () => {
    const transcriptGetter = Object.getOwnPropertyDescriptor(ChatSession.prototype, 'transcript')!.get!;
    const transcript = vi.spyOn(ChatSession.prototype, 'transcript', 'get').mockImplementation(function (
      this: ChatSession,
    ) {
      return (transcriptGetter.call(this) as ChatSession['transcript']).map(({ tools: _tools, ...turn }) => turn);
    });
    const send = vi.fn(async () => {});
    const harness = await fixture(send);
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Ship' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await vi.waitFor(async () => {
        expect((await goalOf(harness.runtime, harness.chatId))?.idleContinuationsWithoutToolCalls).toBe(1);
      });
      expect((await harness.runtime.snapshot()).runs.at(-1)?.options?.mode).toBe(AgentModeID.AGENT);
    } finally {
      transcript.mockRestore();
      await harness.runtime.dispose();
    }
  });

  it('arms a goal from the composer and refuses a second goal while it is open', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });

      expect(harness.events.at(-1)).toMatchObject({
        type: GlyphHostEventType.CHAT_UPDATED,
        chat: { id: harness.chatId, goal: { objective: 'Make CI green', status: 'active', continuationCount: 0 } },
      });
      await expect(
        harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Another' }),
      ).rejects.toThrow('already has a goal');
      expect(harness.saved.get(harness.chatId)?.goal?.objective).toBe('Make CI green');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('starts one continuation turn that receives the objective as untrusted context', async () => {
    const requests: string[] = [];
    const harness = await fixture(async options => {
      requests.push(options.toolContext?.chat?.id ?? '');
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });

      expect(requests).toEqual([harness.chatId]);
      expect((await harness.runtime.snapshot()).runs.at(-1)).toMatchObject({
        runId: `goal-continuation:${goal.id}:1`,
        userText: 'Continue working toward the active goal.',
      });
      expect(harness.recorded.flat()).toEqual([
        {
          schemaVersion: 1,
          id: `goal-continuation:${goal.id}:1`,
          type: 'goal_continuation',
          payload: { goalId: goal.id, objective: 'Make CI green', continuation: 1 },
        },
      ]);
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({
        status: 'active',
        continuationCount: 1,
        idleContinuationsWithoutToolCalls: 1,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it.each([
    [
      'a goal that no longer exists',
      async (runtime: ProviderDesktopRuntime, chatId: string, goalId: string) => {
        await runtime.handle({ type: Command.CLEAR_GOAL, chatId, goalId });
      },
    ],
    [
      'a paused goal',
      async (runtime: ProviderDesktopRuntime, chatId: string, goalId: string) => {
        await runtime.handle({ type: Command.PAUSE_GOAL, chatId, goalId });
      },
    ],
  ])('does not continue %s', async (_, change) => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await change(harness.runtime, harness.chatId, goal.id);

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: 'stale' });

      expect(sends).toBe(0);
      expect((await harness.runtime.snapshot()).runs).toEqual([]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('waits for a running turn to finish before continuing the goal it was asked to continue', async () => {
    const gate = deferredVoid();
    let sends = 0;
    const harness = await fixture(async () => {
      if (++sends === 1) await gate.promise;
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(sends).toBe(1);
      });

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      expect(sends).toBe(1);
      gate.resolve();

      await vi.waitFor(() => {
        expect(sends).toBe(2);
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)).toMatchObject({
          runId: `goal-continuation:${goal.id}:1`,
          status: GlyphRunStatus.COMPLETED,
        });
      });
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });

  it('lets pending shell events run before a goal continuation', async () => {
    const gate = deferredVoid();
    const texts: string[] = [];
    const harness = await fixture(async () => {
      texts.push((await harness.runtime.snapshot()).runs.at(-1)?.userText ?? '');
      if (texts.length === 1) await gate.promise;
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(texts).toHaveLength(1);
      });
      harness.wake({
        id: 'wake-1',
        terminalId: 'terminal',
        ownerChatId: harness.chatId,
        pattern: 'READY',
        command: 'server',
        workingDirectory: '/project',
        output: 'READY\n',
        matchedAt: new Date().toISOString(),
      });

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      gate.resolve();

      await vi.waitFor(() => {
        expect(texts).toEqual(['Work', 'Wake condition matched: READY', 'Continue working toward the active goal.']);
      });
    } finally {
      gate.resolve();
      await harness.runtime.dispose();
    }
  });

  it('pauses a goal after three continuations in a row that make no tool calls', async () => {
    let sends = 0;
    const harness = await fixture(async () => {
      sends++;
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;

      for (const continuation of [1, 2, 3]) {
        await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
        await vi.waitFor(async () => {
          expect((await goalOf(harness.runtime, harness.chatId))?.idleContinuationsWithoutToolCalls).toBe(continuation);
        });
      }
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });

      expect(sends).toBe(3);
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({
        status: 'paused',
        pauseReason: 'stalled',
        continuationCount: 3,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps a working goal active by clearing the idle streak whenever a continuation uses tools', async () => {
    let sends = 0;
    const harness = await fixture(async options => {
      if (++sends % 2 === 0)
        options.onToolActivity?.({
          callId: `call-${sends}`,
          name: 'read',
          arguments: '{}',
          phase: ToolActivityPhase.COMPLETED,
          output: '{}',
        });
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;

      for (const idle of [1, 0, 1, 0]) {
        const count = sends + 1;
        await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
        await vi.waitFor(async () => {
          expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({
            continuationCount: count,
            idleContinuationsWithoutToolCalls: idle,
          });
        });
        await vi.waitFor(async () => {
          expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
        });
      }

      expect((await goalOf(harness.runtime, harness.chatId))?.status).toBe('active');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('pauses the goal when the human stops a running turn', async () => {
    const harness = await fixture(async (options, interactions) => {
      await interactions.presentShellPermission({ command: 'true', workingDirectory: '/project' }, options.signal);
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
      });

      await harness.runtime.handle({
        type: Command.CANCEL_RUN,
        chatId: harness.chatId,
        runId: `goal-continuation:${goal.id}:1`,
      });

      await vi.waitFor(async () => {
        expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({ status: 'paused', pauseReason: 'user' });
      });
      expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.CANCELLED);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('pauses the goal when a turn fails so it cannot retry in a loop', async () => {
    const harness = await fixture(async () => {
      throw new Error('Provider unavailable');
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });

      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });

      await vi.waitFor(async () => {
        expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({
          status: 'paused',
          pauseReason: 'failed',
        });
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('leaves the goal untouched after an ordinary turn completes', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const before = await goalOf(harness.runtime, harness.chatId);

      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Work',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });

      expect(await goalOf(harness.runtime, harness.chatId)).toEqual(before);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('stops continuing once the agent marks the goal complete', async () => {
    let sends = 0;
    const harness = await fixture(async options => {
      sends++;
      await harness.runtime.updateGoalFromTool(options.toolContext!.chat!, GoalStatus.COMPLETE);
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });
      await vi.waitFor(async () => {
        expect((await goalOf(harness.runtime, harness.chatId))?.status).toBe('complete');
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });

      expect(sends).toBe(1);
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({
        status: 'complete',
        continuationCount: 1,
        idleContinuationsWithoutToolCalls: 0,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('lets the agent resume a paused goal only from a turn the human started', async () => {
    const outcomes: string[] = [];
    const harness = await fixture(async options => {
      try {
        await harness.runtime.updateGoalFromTool(options.toolContext!.chat!, GoalStatus.ACTIVE);
        outcomes.push('resumed');
      } catch (error) {
        outcomes.push((error as Error).message);
      }
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'early',
        text: 'Resume it',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(outcomes).toHaveLength(1);
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      await harness.runtime.handle({ type: Command.PAUSE_GOAL, chatId: harness.chatId, goalId: goal.id });

      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Resume it',
        attachments: [],
      });
      await vi.waitFor(() => {
        expect(outcomes).toHaveLength(2);
      });

      expect(outcomes).toEqual(['Only a paused goal can be resumed.', 'resumed']);
      expect((await goalOf(harness.runtime, harness.chatId))?.status).toBe('active');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('refuses to let a continuation turn resume a paused goal', async () => {
    const outcomes: string[] = [];
    const harness = await fixture(async options => {
      const chat = options.toolContext!.chat!;
      await harness.runtime.handle({
        type: Command.PAUSE_GOAL,
        chatId: chat.id,
        goalId: (await goalOf(harness.runtime, chat.id))!.id,
      });
      await harness.runtime.updateGoalFromTool(chat, GoalStatus.ACTIVE).catch((error: unknown) => {
        outcomes.push(error instanceof Error ? error.message : String(error));
      });
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;

      await harness.runtime.handle({ type: Command.CONTINUE_GOAL, chatId: harness.chatId, goalId: goal.id });

      await vi.waitFor(() => {
        expect(outcomes).toEqual(['Only the human can resume a paused goal. Ask them before resuming it.']);
      });
      expect((await goalOf(harness.runtime, harness.chatId))?.status).toBe('paused');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('pauses, resumes, and clears the current goal while rejecting a stale one', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });
      const goal = (await goalOf(harness.runtime, harness.chatId))!;

      await harness.runtime.handle({ type: Command.PAUSE_GOAL, chatId: harness.chatId, goalId: goal.id });
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({ status: 'paused', pauseReason: 'user' });
      await harness.runtime.handle({ type: Command.RESUME_GOAL, chatId: harness.chatId, goalId: goal.id });
      expect((await goalOf(harness.runtime, harness.chatId))?.status).toBe('active');
      await expect(
        harness.runtime.handle({ type: Command.PAUSE_GOAL, chatId: harness.chatId, goalId: 'stale' }),
      ).rejects.toThrow('no longer current');
      await harness.runtime.handle({ type: Command.CLEAR_GOAL, chatId: harness.chatId, goalId: goal.id });

      expect(await goalOf(harness.runtime, harness.chatId)).toBeUndefined();
      expect(harness.saved.get(harness.chatId)?.goal).toBeUndefined();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('rejects a pause for a goal replaced while the request was waiting for storage', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'First' });
      const first = (await goalOf(harness.runtime, harness.chatId))!;
      const gate = deferredVoid();
      const save = harness.store.save.bind(harness.store);
      const saving = vi.spyOn(harness.store, 'save').mockImplementationOnce(async record => {
        await gate.promise;
        await save(record);
      });
      const clearing = harness.runtime.handle({ type: Command.CLEAR_GOAL, chatId: harness.chatId, goalId: first.id });
      await vi.waitFor(() => {
        expect(saving).toHaveBeenCalled();
      });
      const replacing = harness.runtime.handle({
        type: Command.CREATE_GOAL,
        chatId: harness.chatId,
        objective: 'Second',
      });
      const pausing = harness.runtime.handle({ type: Command.PAUSE_GOAL, chatId: harness.chatId, goalId: first.id });
      gate.resolve();

      await clearing;
      await replacing;
      await expect(pausing).rejects.toThrow('no longer current');
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({ objective: 'Second', status: 'active' });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('arms an agent-proposed goal only after the human approves it', async () => {
    const results: unknown[] = [];
    const harness = await fixture(async options => {
      results.push(await harness.runtime.proposeGoal(options.toolContext!.chat!, 'Make CI green', options.signal));
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'decline',
        text: 'Keep going',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.approval?.goal).toEqual({ objective: 'Make CI green' });
      });
      const declined = (await harness.runtime.snapshot()).runs.at(-1)!.approval!;
      await harness.runtime.handle({
        type: Command.DECIDE_APPROVAL,
        chatId: harness.chatId,
        runId: 'decline',
        approvalId: declined.id,
        decision: GlyphApprovalDecision.DENY,
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.COMPLETED);
      });
      expect(await goalOf(harness.runtime, harness.chatId)).toBeUndefined();

      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'approve',
        text: 'Keep going',
        attachments: [],
      });
      await vi.waitFor(async () => {
        expect((await harness.runtime.snapshot()).runs.at(-1)?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
      });
      const approval = (await harness.runtime.snapshot()).runs.at(-1)!.approval!;
      await harness.runtime.handle({
        type: Command.DECIDE_APPROVAL,
        chatId: harness.chatId,
        runId: 'approve',
        approvalId: approval.id,
        decision: GlyphApprovalDecision.ALLOW_ONCE,
      });
      await vi.waitFor(() => {
        expect(results).toHaveLength(2);
      });

      expect(results[0]).toBeUndefined();
      expect(results[1]).toMatchObject({ objective: 'Make CI green', status: 'active' });
      expect(await goalOf(harness.runtime, harness.chatId)).toMatchObject({ objective: 'Make CI green' });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('refuses an agent goal proposal while the chat already has a goal', async () => {
    const outcomes: string[] = [];
    const harness = await fixture(async options => {
      await harness.runtime
        .proposeGoal(options.toolContext!.chat!, 'Another', options.signal)
        .catch((error: unknown) => {
          outcomes.push(error instanceof Error ? error.message : String(error));
        });
    });
    try {
      await harness.runtime.handle({ type: Command.CREATE_GOAL, chatId: harness.chatId, objective: 'Make CI green' });

      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'manual',
        text: 'Keep going',
        attachments: [],
      });

      await vi.waitFor(() => {
        expect(outcomes).toEqual(['This chat already has a goal. Ask the human to clear it before proposing another.']);
      });
      expect((await harness.runtime.snapshot()).runs.at(-1)?.approval).toBeUndefined();
    } finally {
      await harness.runtime.dispose();
    }
  });
});
