import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { ContextAttachment } from '#src/context/attachments/ContextAttachment.js';
import { ChatSteeringQueue } from '#src/chat/ChatSteeringQueue.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { toToolActivityPreview } from '#src/chat/toToolActivityPreview.js';
import type { QuestionFormResult } from '#src/interaction/questions/QuestionFormResult.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { chatTurnOptionsSchema } from '#src/chat/ChatTurnOptionsSchema.js';
import type { ShellCommandSummary } from '#src/shell/ShellCommandSummary.js';
import { toShellCommandSummary } from '#src/shell/toShellCommandSummary.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import type { GlyphService } from '#src/application/GlyphService.js';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { Model } from '#src/chat/Model.js';
import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { ProtocolError } from '#src/errors/ProtocolError.js';
import { toGlyphProposalFilePreview } from './toGlyphProposalFilePreview.ts';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';
import type { DesktopInteractionBroker } from './DesktopInteractionBroker.ts';
import type {
  GlyphDesktopWorkspaceRuntime,
  GlyphRuntimeCommand,
  GlyphRuntimeSnapshot,
} from './GlyphDesktopWorkspaceRuntime.ts';
import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';

const TOOL_ACTIVITY_PHASE_TO_GLYPH_TOOL_ACTIVITY_STATUS = {
  [ToolActivityPhase.STARTED]: GlyphToolActivityStatus.STARTED,
  [ToolActivityPhase.COMPLETED]: GlyphToolActivityStatus.COMPLETED,
  [ToolActivityPhase.FAILED]: GlyphToolActivityStatus.FAILED,
  [ToolActivityPhase.INTERRUPTED]: GlyphToolActivityStatus.INTERRUPTED,
} as const satisfies Record<ToolActivityPhase, GlyphToolActivityStatus>;

interface ActiveRun {
  readonly steering: ChatSteeringQueue;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly runId: string;
}

/** Adapts the existing application service to desktop commands without moving provider logic into Electron. */
export class ProviderDesktopRuntime implements GlyphDesktopWorkspaceRuntime {
  private readonly shellCalls = new Map<string, { readonly runId: string; readonly toolId: string }>();
  private readonly runs = new Map<string, GlyphRunProjection>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly historyChanges = new Set<string>();
  private readonly sessions = new Map<string, ChatSession>();
  private readonly proposals = new Map<string, GlyphProposalSummary>();
  private readonly usageByChat: Record<string, GlyphUsage> = {};
  private selectedAccount: ChatAccount | undefined;
  private models: readonly Model[] = [];
  private selectedModel: Model | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private discovery = new AbortController();
  private accountSelectionRevisionNumber = 0;
  private readonly commands = new Set<Promise<void>>();
  private readonly unsubscribeShells: () => void;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly options: {
      readonly glyph: GlyphService;
      readonly interactions: DesktopInteractionBroker;
      readonly shellSessions: Pick<
        ShellSessionManager,
        'close' | 'dispose' | 'writeInput' | 'allSessions' | 'onDidChange'
      >;
      readonly emit: (event: GlyphHostEvent) => void;
      readonly ownerWindowId: string;
    },
  ) {
    this.unsubscribeShells = options.shellSessions.onDidChange(() => this.syncShells());
    this.unsubscribe = options.glyph.proposalReviews?.onDidChange(change => {
      for (const id of change.proposalIds) {
        const proposal = options.glyph.proposalReviews?.get(id);
        const previous = this.proposals.get(id);
        const summary = this.proposalSummary(proposal, previous);
        if (!summary) continue;
        this.proposals.set(id, summary);
        this.publish({ type: GlyphHostEventType.PROPOSAL_CHANGED, chatId: summary.chatId ?? '', proposal: summary });
      }
    });
  }

  /** Rebuild reconnect state from live reviews so missed notifications cannot leave stale decisions. */
  async snapshot(): Promise<GlyphRuntimeSnapshot> {
    for (const proposal of this.options.glyph.proposalReviews?.activeReviews ?? [])
      this.proposals.set(proposal.id, toProposal(proposal));
    return {
      accounts: this.options.glyph.accounts,
      models: this.models,
      chats: this.options.glyph.listChats(),
      runs: [...this.runs.values()],
      proposals: [...this.proposals.values()],
      usageByChat: { ...this.usageByChat },
      ...(this.selectedAccount
        ? { selectedAccount: { provider: this.selectedAccount.provider, id: this.selectedAccount.id } }
        : {}),
      ...(this.selectedModel ? { selectedModel: this.selectedModel.slug } : {}),
    };
  }

  /** Dispatch commands without holding the request acknowledgement open for an entire model turn. */
  handle(command: GlyphRuntimeCommand): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The workspace runtime has stopped.'));
    const pending = this.dispatch(command);
    this.commands.add(pending);
    void pending.then(
      () => this.commands.delete(pending),
      () => this.commands.delete(pending),
    );
    return pending;
  }

  private async dispatch(command: GlyphRuntimeCommand): Promise<void> {
    if (this.disposed) throw new Error('The workspace runtime has stopped.');
    const glyph = this.options.glyph;
    switch (command.type) {
      case GlyphWorkbenchCommandType.SELECT_ACCOUNT: {
        const selection = ++this.accountSelectionRevisionNumber;
        const account = this.account(command.accountProvider, command.accountId);
        const signal = this.discovery.signal;
        const models = await glyph.listModels(account, signal);
        signal.throwIfAborted();
        // During the await, the user may have selected again, so we need to check the revision number again
        if (selection !== this.accountSelectionRevisionNumber) return;
        this.selectedAccount = account;
        this.models = models;
        this.selectedModel = models[0];
        return;
      }
      case GlyphWorkbenchCommandType.SELECT_MODEL: {
        const model = this.models.find(model => model.slug === command.model);
        if (!model) throw new Error('Select an available model for the current account.');
        this.selectedModel = model;
        return;
      }
      case GlyphWorkbenchCommandType.LIST_CHATS: {
        const account =
          command.accountProvider && command.accountId
            ? this.account(command.accountProvider, command.accountId)
            : undefined;
        for (const chat of glyph.listChats(account)) this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat });
        return;
      }
      case GlyphWorkbenchCommandType.CREATE_CHAT: {
        const account = this.account(command.accountProvider, command.accountId);
        const signal = this.discovery.signal;
        const models = await glyph.listModels(account, signal);
        signal.throwIfAborted();
        const model = models.find(value => value.slug === command.model);
        if (!model) throw new Error('The selected model is unavailable.');
        this.selectedAccount = account;
        this.models = models;
        this.selectedModel = model;
        const session = await glyph.createChat(account, model);
        // An admitted checkpoint must settle, but its departed renderer should
        // not receive a late chat-selection event from the completed command.
        signal.throwIfAborted();
        this.sessions.set(session.id, session);
        this.publish({
          type: GlyphHostEventType.CHAT_UPDATED,
          chat: session.summary,
          ...(command.creationId ? { creationId: command.creationId } : {}),
        });
        return;
      }
      case GlyphWorkbenchCommandType.BRANCH_CHAT:
      case GlyphWorkbenchCommandType.RESTORE_CHECKPOINT: {
        const source = this.session(command.chatId);
        if (this.active.has(source.id) || this.historyChanges.has(source.id))
          throw new ProtocolError('Wait for this chat to finish before changing its history.');
        this.historyChanges.add(source.id);
        try {
          if (command.type === GlyphWorkbenchCommandType.BRANCH_CHAT) {
            const account = this.account(source.summary.accountProvider, source.summary.accountId);
            const fork = await glyph.branchChat(source.id, command.turnId, account);
            this.sessions.set(fork.id, fork);
            this.seedHistory(fork);
            this.publishUsage(fork);
            this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: fork.summary, creationId: command.creationId });
          } else {
            const { turn } = await source.historyAt(command.turnId);
            await source.restoreCheckpoint(command.turnId);
            for (const [id, run] of this.runs) if (run.chatId === source.id) this.runs.delete(id);
            this.seedHistory(source);
            this.publish({
              type: GlyphHostEventType.CHAT_RESTORED,
              chatId: source.id,
              runs: [...this.runs.values()].filter(run => run.chatId === source.id),
              draft: {
                text: turn.userText,
                ...(turn.options ? { options: turn.options } : {}),
                attachments: (turn.attachments ?? []).map(attachment => ({
                  kind: attachment.source?.range
                    ? GlyphContextAttachmentKind.SELECTION
                    : GlyphContextAttachmentKind.FILE,
                  uri: attachment.source?.uri ?? attachment.path,
                  path: attachment.path,
                  text: attachment.text,
                  contentRevision: attachment.revision,
                  sourceRevision: attachment.source?.revision ?? attachment.revision,
                  sourceVersion: attachment.source?.version ?? 0,
                  ...(attachment.source?.range ? { range: attachment.source.range } : {}),
                  ...(attachment.source?.side ? { side: attachment.source.side } : {}),
                })),
              },
            });
            this.publishUsage(source);
            this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: source.summary });
          }
        } finally {
          this.historyChanges.delete(source.id);
        }
        return;
      }
      case GlyphWorkbenchCommandType.OPEN_CHAT: {
        const session = this.session(command.chatId);
        this.publishUsage(session);
        // Durable history seeds an empty projection only; replay must not duplicate live turns.
        if (!this.active.has(session.id) && ![...this.runs.values()].some(run => run.chatId === session.id)) {
          this.seedHistory(session);
        }
        this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: session.summary });
        return;
      }
      case GlyphWorkbenchCommandType.SET_CHAT_MODE: {
        this.session(command.chatId);
        const chat = await glyph.setChatMode(command.chatId, command.mode);
        this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat });
        return;
      }
      case GlyphWorkbenchCommandType.LINK_PLAN: {
        const source = this.session(command.chatId);
        const target = this.session(command.targetChatId);
        const plan = source.summary.plans?.findLast(value => value.id === command.planId);
        if (!plan) throw new ProtocolError('The plan is unavailable.');
        const summary = await glyph.linkPlan(command.chatId, command.planId, command.targetChatId, command.role);
        this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
        if (command.role === 'Reviewer')
          this.publish({
            type: GlyphHostEventType.CHAT_UPDATED,
            chat: await glyph.setChatMode(target.id, AgentModeID.PLAN),
          });
        await target.recordContext([
          {
            schemaVersion: 1,
            id: `plan:${plan.id}:${plan.revision}:${command.role}`,
            type: 'plan_reference',
            payload: { plan, role: command.role, authorization: 'Context only. The human must request execution.' },
          },
        ]);
        return;
      }
      case GlyphWorkbenchCommandType.UPDATE_PLAN: {
        if (this.active.has(command.chatId))
          throw new ProtocolError('Wait for the active turn before editing the plan.');
        const session = this.session(command.chatId);
        const plan = command.plan;
        const summary = await glyph.updatePlan(session.summary, {
          id: plan.id,
          expectedRevision: plan.revision,
          title: plan.title,
          summary: plan.summary,
          markdown: plan.markdown,
          todos: [...plan.todos],
        });
        this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
        return;
      }
      case GlyphWorkbenchCommandType.SEND: {
        chatTurnOptionsSchema.parse(command.options ?? {});
        if (this.active.has(command.chatId) || this.historyChanges.has(command.chatId))
          throw new ProtocolError('This chat already has an active run or history change.');
        if (this.runs.has(command.runId)) throw new Error('This run id has already been used.');
        const session = this.session(command.chatId);
        const controller = new AbortController();
        const steering = new ChatSteeringQueue();
        // Defer execution one microtask so cancellation can always find its controller.
        const completion = Promise.resolve().then(() =>
          this.send(
            {
              ...command,
              options: {
                ...command.options,
                mode: command.options?.mode ?? session.summary.mode ?? AgentMode.default.id,
              },
            },
            session,
            controller.signal,
            steering,
          ),
        );
        this.active.set(command.chatId, { controller, completion, runId: command.runId, steering });
        void completion.finally(() => {
          steering.close();
          this.active.delete(command.chatId);
        });
        return;
      }
      case GlyphWorkbenchCommandType.STEER: {
        const options = chatTurnOptionsSchema.parse(command.options ?? {});
        const active = this.active.get(command.chatId);
        const run = this.runs.get(command.runId);
        if (!active || active.runId !== command.runId || active.controller.signal.aborted || !run)
          throw new ProtocolError('There is no active response to steer.');
        if (!command.text.trim()) throw new ProtocolError('Steering instructions cannot be empty.');
        const attachments = command.attachments;
        if (
          attachments.length > 32 ||
          attachments.reduce((total, value) => total + Buffer.byteLength(value.text), 0) > 2 * 1024 * 1024
        )
          throw new ProtocolError('Reduce the selected context to at most 32 attachments and 2 MiB.');
        active.steering.add(
          { text: command.text, ...options, attachments: toRequestAttachments(attachments) },
          {
            id: command.messageId,
            text: command.text,
            createdAt: new Date().toISOString(),
            options,
            attachments: attachments.map(attachment => ({
              uri: attachment.uri,
              path: attachment.path,
              text: attachment.text,
              revision: attachment.contentRevision,
              ...(attachment.range ? { range: attachment.range } : {}),
              ...(attachment.side ? { side: attachment.side } : {}),
            })),
          },
        );
        this.setRun({ ...run, steering: active.steering.messages });
        return;
      }
      case GlyphWorkbenchCommandType.CANCEL_RUN: {
        const active = this.active.get(command.chatId);
        if (active?.runId === command.runId) active.controller.abort(new Error('Response cancelled.'));
        return;
      }
      case GlyphWorkbenchCommandType.ANSWER_QUESTION: {
        this.options.interactions.answer({
          ...command,
          id: command.questionId,
          kind: 'question',
          value: command.answer,
        });
        // The broker validated ownership, completeness, and choice IDs synchronously.
        const run = this.runs.get(command.runId)!;
        const request = run.question!;
        const result = command.answer as QuestionFormResult;
        const response = {
          id: request.id,
          answers: (request.questions ?? [{ id: request.id, prompt: request.prompt, options: [] }]).map(question => {
            const answer = result.answers.find(value => value.questionId === question.id)!;
            return {
              question: question.prompt,
              answer:
                answer.type === QuestionAnswerType.OTHER
                  ? answer.text.trim()
                  : question.options
                      .filter(option => answer.optionIds.includes(option.id))
                      .map(option => option.label)
                      .join(', '),
            };
          }),
        };
        this.runs.set(command.runId, { ...run, questionResponses: [...(run.questionResponses ?? []), response] });
        // Only a broker-validated decision may clear the waiting state.
        this.resumeRun(command.runId);
        return;
      }
      case GlyphWorkbenchCommandType.DECIDE_APPROVAL: {
        this.options.interactions.answer({
          ...command,
          id: command.approvalId,
          kind: 'approval',
          value: command.decision,
        });
        this.resumeRun(command.runId);
        return;
      }
      case GlyphWorkbenchCommandType.WRITE_SHELL_INPUT: {
        this.session(command.chatId);
        if (command.input.length > 64 * 1024) throw new Error('Shell input exceeds 64 KiB.');
        await this.options.shellSessions.writeInput({
          terminalId: command.sessionId,
          input: command.input,
          appendNewline: command.appendNewline,
          ownerChatId: command.chatId,
          signal: this.discovery.signal,
        });
        return;
      }
      case GlyphWorkbenchCommandType.STOP_SHELL_SESSION: {
        this.session(command.chatId);
        await this.options.shellSessions.close(command.sessionId, command.chatId);
        return;
      }
      case GlyphWorkbenchCommandType.READ_PROPOSAL_FILE: {
        const session = this.session(command.chatId);
        const proposal = this.options.glyph.proposalReviews?.get(command.proposalId);
        if (
          !proposal ||
          proposal.origin?.chatId !== session.id ||
          proposal.origin.accountId !== session.summary.accountId ||
          proposal.origin.accountProvider !== session.summary.accountProvider
        )
          throw new ProtocolError('This proposal does not belong to that chat.');
        const file = proposal.files.find(file => file.id === command.fileId);
        if (!file) throw new ProtocolError('This proposal file is no longer available.');
        if (file.operation !== EditOperation.UPDATE)
          throw new ProtocolError('Only text changes can be reviewed in the editor.');
        this.publish({
          type: GlyphHostEventType.PROPOSAL_PREVIEW,
          preview: toGlyphProposalFilePreview(proposal.id, file),
        });
        return;
      }
      case GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM:
      case GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM:
        return this.decideProposal(command);
    }
  }

  /** Check the originating chat and account before a renderer-supplied id can mutate a review. */
  private async decideProposal(
    command: Extract<
      GlyphRuntimeCommand,
      {
        type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM | GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM;
      }
    >,
  ): Promise<void> {
    const glyph = this.options.glyph;
    const reviews = glyph.proposalReviews;
    const review = reviews?.get(command.proposalId);
    const session = this.session(command.chatId);
    if (
      !reviews ||
      !review ||
      review.origin?.chatId !== command.chatId ||
      review.origin.accountId !== session.summary.accountId ||
      review.origin.accountProvider !== session.summary.accountProvider
    ) {
      throw new ProtocolError('This proposal does not belong to that chat.');
    }
    if (command.type === GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM)
      await reviews.acceptInReview(command.proposalId, command.itemId);
    else await reviews.rejectInReview(command.proposalId, command.itemId, command.comment);
    await glyph.commitReviewResults(session, { currentChatOnly: true });
  }

  /** Pending prompts are cancelled when their owning renderer disappears. */
  async connectionLost(windowId: string): Promise<void> {
    if (windowId !== this.options.ownerWindowId) return;
    const discovery = this.discovery;
    // A renderer reload can reuse this runtime. New commands get a fresh
    // discovery scope while in-flight requests retain the cancelled one.
    this.discovery = new AbortController();
    discovery.abort(new Error('Model discovery cancelled because the owning window disconnected.'));
    for (const run of this.active.values()) run.controller.abort(new Error('The owning window disconnected.'));
    await Promise.allSettled([...this.active.values()].map(run => run.completion));
  }

  /** Settle active operations before closing their shell and persistence dependencies. */
  dispose(): Promise<void> {
    return (this.disposal ??= this.stop());
  }

  private async stop(): Promise<void> {
    this.disposed = true;
    await this.connectionLost(this.options.ownerWindowId);
    // Proposal decisions checkpoint after their editor side effect. Closing
    // persistence before those admitted commands settle would lose the outcome.
    await Promise.allSettled(this.commands);
    this.unsubscribe?.();
    this.unsubscribeShells();
    try {
      await this.options.shellSessions.dispose();
    } finally {
      await this.options.glyph.dispose();
    }
  }

  /** Record pending decisions before delivery so reconnect snapshots cannot lose a waiting prompt. */
  publish(event: GlyphHostEvent): void {
    if (event.type === GlyphHostEventType.QUESTION || event.type === GlyphHostEventType.APPROVAL) {
      const run = this.runs.get(event.runId);
      if (run)
        this.runs.set(
          event.runId,
          event.type === GlyphHostEventType.QUESTION
            ? { ...run, question: event.question, status: GlyphRunStatus.WAITING_FOR_QUESTION }
            : {
                ...run,
                approval: event.approval,
                status: GlyphRunStatus.WAITING_FOR_APPROVAL,
                ...(event.approval.modeSwap ? { modeSwaps: [...(run.modeSwaps ?? []), event.approval.modeSwap] } : {}),
              },
        );
    }
    this.options.emit(event);
  }

  finishModeSwap(chatId: string, id: string, status: GlyphModeSwap['status']): void {
    const run = [...this.runs.values()].find(
      run => run.chatId === chatId && run.modeSwaps?.some(swap => swap.id === id),
    );
    if (!run) return;
    const updated = { ...run, modeSwaps: run.modeSwaps!.map(swap => (swap.id === id ? { ...swap, status } : swap)) };
    if (updated.approval?.id === id) {
      const { approval: _approval, ...rest } = updated;
      this.setRun({ ...rest, status: GlyphRunStatus.STREAMING });
    } else this.setRun(updated);
  }

  /** Recheck inference access at use time rather than trusting a previously selected account. */
  private seedHistory(session: ChatSession): void {
    session.transcript.forEach((turn, index) =>
      this.setRun({
        chatId: session.id,
        runId: `${session.id}:history:${index}`,
        userText: turn.userText,
        ...(turn.steering ? { steering: turn.steering } : {}),
        createdAt: turn.createdAt,
        ...(turn.modeSwaps ? { modeSwaps: turn.modeSwaps } : {}),
        ...(turn.questionResponses ? { questionResponses: turn.questionResponses } : {}),
        ...(turn.checkpoints ? { checkpointTurnId: turn.options?.turnId ?? `${session.id}:history:${index}` } : {}),
        ...(turn.usage ? { usage: { ...turn.usage, unreportedTurns: turn.usage.incomplete ? 1 : 0 } } : {}),
        ...(turn.options ? { options: turn.options } : {}),
        ...(turn.attachments
          ? {
              attachments: turn.attachments.map(attachment => ({
                path: attachment.path,
                ...(attachment.source?.uri ? { uri: attachment.source.uri } : {}),
                text: attachment.text,
                revision: attachment.revision,
                ...(attachment.source?.range ? { range: attachment.source.range } : {}),
                ...(attachment.source?.side ? { side: attachment.source.side } : {}),
              })),
            }
          : {}),
        text: turn.assistantText,
        reasoning: turn.reasoningSummary,
        tools: (turn.tools ?? []).map(tool => ({
          id: tool.callId,
          name: tool.name,
          status: TOOL_ACTIVITY_PHASE_TO_GLYPH_TOOL_ACTIVITY_STATUS[tool.phase],
          ...(tool.arguments === undefined ? {} : { arguments: this.options.glyph.redact(tool.arguments) }),
          ...(tool.output === undefined ? {} : { summary: this.options.glyph.redact(tool.output) }),
          ...(tool.textOffset === undefined ? {} : { textOffset: tool.textOffset }),
          ...(tool.shell ? { shell: { ...this.redactShell(tool.shell), live: false, running: false } } : {}),
        })),
        status: GlyphRunStatus.COMPLETED,
      }),
    );
  }

  private account(provider: string, id: string): ChatAccount {
    const account = this.options.glyph.accounts.find(value => value.provider === provider && value.id === id);
    if (!account?.connected || !account.inferenceAccess)
      throw new Error('Connect an account with inference access first.');
    return account;
  }

  /** Resolve through this workspace’s chat catalog to reject ids belonging to another workspace. */
  private session(id: string): ChatSession {
    const summary = this.options.glyph.listChats().find(chat => chat.id === id);
    if (!summary) throw new Error('Unknown chat in this workspace.');
    const account = this.account(summary.accountProvider, summary.accountId);
    const session = this.sessions.get(id) ?? this.options.glyph.openChat(id, account);
    this.sessions.set(id, session);
    return session;
  }

  /** Keep provider streaming behind the application service while retaining a recoverable desktop projection. */
  private async send(
    command: Extract<GlyphRuntimeCommand, { type: GlyphWorkbenchCommandType.SEND }>,
    session: ChatSession,
    signal: AbortSignal,
    steering: ChatSteeringQueue,
  ): Promise<void> {
    this.setRun({
      chatId: command.chatId,
      runId: command.runId,
      userText: command.text,
      createdAt: new Date().toISOString(),
      options: { ...command.options, turnId: command.runId },
      attachments: command.attachments.map(attachment => ({
        uri: attachment.uri,
        path: attachment.path,
        text: attachment.text,
        revision: attachment.contentRevision,
        ...(attachment.range ? { range: attachment.range } : {}),
        ...(attachment.side ? { side: attachment.side } : {}),
      })),
      text: '',
      reasoning: '',
      tools: [],
      status: GlyphRunStatus.STREAMING,
    });
    try {
      // Review decisions must enter provider history before the next turn can reason about the files.
      await this.options.glyph.commitReviewResults(session, { currentChatOnly: true, signal });
      signal.throwIfAborted();
      // Bind tool prompts to this exact run so another chat cannot answer them.
      await this.options.interactions.run(command, () =>
        session.send(
          {
            text: command.text,
            ...command.options,
            turnId: command.runId,
            attachments: toRequestAttachments(command.attachments),
          },
          { push: part => this.response(command.runId, part) },
          signal,
          () => this.runs.get(command.runId)?.questionResponses ?? [],
          () => this.runs.get(command.runId)?.modeSwaps ?? [],
          steering,
        ),
      );
      const run = this.runs.get(command.runId)!;
      const turn = session.transcript.at(-1);
      this.setRun({
        ...run,
        status: signal.aborted ? GlyphRunStatus.CANCELLED : GlyphRunStatus.COMPLETED,
        ...(turn?.options?.turnId === command.runId
          ? { createdAt: turn.createdAt, ...(turn.checkpoints ? { checkpointTurnId: command.runId } : {}) }
          : {}),
        ...(!signal.aborted && turn?.options?.turnId === command.runId && turn.usage
          ? { usage: { ...turn.usage, unreportedTurns: turn.usage.incomplete ? 1 : 0 } }
          : {}),
      });
      this.publishUsage(session);
      this.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: session.summary });
    } catch (error) {
      const run = this.runs.get(command.runId)!;
      // A failed or cancelled turn must not leave an actionable approval behind.
      const { question: _question, approval: _approval, ...settled } = run;
      this.setRun({
        ...settled,
        status: signal.aborted ? GlyphRunStatus.CANCELLED : GlyphRunStatus.FAILED,
        terminalMessage: this.options.glyph.redact(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  /** Update replayable state before publishing deltas; tool ids replace activity rather than duplicating it. */
  private response(runId: string, part: ChatResponsePart): void {
    const run = this.runs.get(runId)!;
    if (part.type === ChatResponsePartType.TOOL) {
      const previous = run.tools.find(tool => tool.id === part.activity.callId);
      const parsed = toShellCommandSummary(part.activity);
      const summary = parsed ? this.redactShell(parsed) : undefined;
      if (summary && part.activity.executionId)
        this.shellCalls.set(part.activity.executionId, { runId, toolId: part.activity.callId });
      const shell = summary
        ? {
            ...summary,
            ...previous?.shell,
            ...(part.activity.phase === ToolActivityPhase.STARTED ? {} : summary),
            output:
              (summary.background || (summary.error && !summary.output)) && previous?.shell
                ? previous.shell.output
                : summary.output,
            live: previous?.shell?.live ?? false,
            running:
              part.activity.phase === ToolActivityPhase.STARTED || summary.background
                ? (previous?.shell?.running ?? false)
                : false,
          }
        : undefined;
      const activity = {
        id: part.activity.callId,
        name: part.activity.name,
        status:
          shell?.error && part.activity.phase === ToolActivityPhase.COMPLETED
            ? GlyphToolActivityStatus.FAILED
            : TOOL_ACTIVITY_PHASE_TO_GLYPH_TOOL_ACTIVITY_STATUS[part.activity.phase],
        arguments: this.options.glyph.redact(toToolActivityPreview(part.activity.arguments)),
        textOffset: previous?.textOffset ?? run.text.length,
        ...(part.activity.output
          ? { summary: this.options.glyph.redact(toToolActivityPreview(part.activity.output)) }
          : {}),
        ...(shell ? { shell } : {}),
      };
      const tools = run.tools.some(tool => tool.id === activity.id)
        ? run.tools.map(tool => (tool.id === activity.id ? activity : tool))
        : [...run.tools, activity];
      this.runs.set(runId, { ...run, tools });
      this.publish({ type: GlyphHostEventType.TOOL_ACTIVITY, chatId: run.chatId, runId, activity });
      return;
    }
    const kind = this.deltaKind(part.type);
    const value = part.type === ChatResponsePartType.DIAGNOSTIC ? part.message : part.value;
    this.runs.set(runId, {
      ...run,
      text: run.text + (kind === GlyphResponseDeltaKind.TEXT ? value : ''),
      reasoning: run.reasoning + (kind === GlyphResponseDeltaKind.REASONING ? value : ''),
    });
    this.publish({ type: GlyphHostEventType.RESPONSE_DELTA, chatId: run.chatId, runId, delta: { kind, value } });
  }

  private redactShell(summary: ShellCommandSummary): ShellCommandSummary {
    return {
      ...summary,
      command: this.options.glyph.redact(summary.command),
      output: this.options.glyph.redact(summary.output),
      ...(summary.error ? { error: this.options.glyph.redact(summary.error) } : {}),
    };
  }

  /** Correlate process updates by host-supplied execution id, never by command text. */
  private syncShells(): void {
    const sessions = this.options.shellSessions.allSessions;
    for (const [runId, run] of this.runs) {
      for (const tool of run.tools) {
        if (!tool.shell) continue;
        const session = sessions.find(value => {
          const owner = value.executionId ? this.shellCalls.get(value.executionId) : undefined;
          return value.ownerChatId === run.chatId && owner?.runId === runId && owner.toolId === tool.id;
        });
        if (!session && !tool.shell.live && !tool.shell.running) continue;
        const shell = session
          ? {
              ...tool.shell,
              command: this.options.glyph.redact(session.command),
              workingDirectory: session.workingDirectory,
              sessionId: session.id,
              output: this.options.glyph.redact(session.outputTail),
              background: session.background,
              live: session.background,
              running: session.status === ShellSessionStatus.RUNNING,
              ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
            }
          : {
              ...this.redactShell(tool.shell),
              live: false,
              running: false,
            };
        const activity = {
          ...tool,
          shell,
          status: shell.exitCode !== undefined && shell.exitCode !== 0 ? GlyphToolActivityStatus.FAILED : tool.status,
        };
        const current = this.runs.get(runId)!;
        this.runs.set(runId, {
          ...current,
          tools: current.tools.map(value => (value.id === tool.id ? activity : value)),
        });
        this.publish({ type: GlyphHostEventType.TOOL_ACTIVITY, chatId: run.chatId, runId, activity });
      }
    }
  }

  /** Keep provider response categories out of the browser-only protocol. */
  private deltaKind(type: Exclude<ChatResponsePartType, ChatResponsePartType.TOOL>): GlyphResponseDeltaKind {
    switch (type) {
      case ChatResponsePartType.TEXT:
        return GlyphResponseDeltaKind.TEXT;
      case ChatResponsePartType.REASONING_SUMMARY:
        return GlyphResponseDeltaKind.REASONING;
      case ChatResponsePartType.DIAGNOSTIC:
        return GlyphResponseDeltaKind.DIAGNOSTIC;
    }
  }

  private publishUsage(session: ChatSession): void {
    const usage = session.usage;
    this.usageByChat[session.id] = usage;
    this.publish({ type: GlyphHostEventType.USAGE, chatId: session.id, usage });
  }

  /** A removed review still needs a final projection that retires its pending buttons. */
  private proposalSummary(
    proposal: EditProposal | undefined,
    previous: GlyphProposalSummary | undefined,
  ): GlyphProposalSummary | undefined {
    if (proposal) return toProposal(proposal);
    if (!previous) return undefined;
    return { ...previous, files: previous.files.map(file => ({ ...file, pendingItemIds: [] })) };
  }

  /** Drop answered forms so later snapshots cannot offer the same decision twice. */
  private resumeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const { question: _question, approval: _approval, ...rest } = run;
    this.setRun({ ...rest, status: GlyphRunStatus.STREAMING });
  }

  /** Store before emitting so observers and snapshots see the same transition. */
  private setRun(run: GlyphRunProjection): void {
    this.runs.set(run.runId, run);
    this.publish({ type: GlyphHostEventType.RUN_STATE, run });
  }
}

function toProposal(proposal: EditProposal): GlyphProposalSummary {
  return {
    id: proposal.id,
    ...(proposal.origin ? { chatId: proposal.origin.chatId } : {}),
    createdAt: proposal.createdAt,
    files: proposal.files.map(file => ({
      id: file.id,
      path: file.currentPath,
      proposedUri: `glyph-proposal:/${encodeURIComponent(proposal.id)}/${encodeURIComponent(file.id)}`,
      textOnly: file.operation === EditOperation.UPDATE,
      additions: file.items
        .filter(item => item.decision === EditDecisionState.PENDING)
        .reduce((sum, item) => sum + changedLines(item.insertedText), 0),
      deletions: file.items
        .filter(item => item.decision === EditDecisionState.PENDING)
        .reduce((sum, item) => sum + changedLines(item.removedText), 0),
      preview: file.items
        .filter(item => item.decision === EditDecisionState.PENDING)
        .flatMap(item => [
          ...item.removedText
            .split(/\r\n|\r|\n/)
            .filter(Boolean)
            .slice(0, 3)
            .map(text => ({ added: false, text: text.slice(0, 200) })),
          ...item.insertedText
            .split(/\r\n|\r|\n/)
            .filter(Boolean)
            .slice(0, 3)
            .map(text => ({ added: true, text: text.slice(0, 200) })),
        ])
        .slice(0, 6),
      pendingItemIds: file.items.filter(item => item.decision === EditDecisionState.PENDING).map(item => item.id),
      applicability:
        Object.values(GlyphProposalApplicability).find(value => value === String(file.applicability).toLowerCase()) ??
        GlyphProposalApplicability.STALE,
    })),
  };
}

function changedLines(text: string): number {
  return text ? text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length : 0;
}

function toRequestAttachments(attachments: readonly GlyphContextAttachment[]): ContextAttachment[] {
  return attachments.map(attachment => ({
    path: attachment.path,
    text: attachment.text,
    revision: attachment.contentRevision,
    source: {
      kind: attachment.kind,
      uri: attachment.uri,
      version: attachment.token?.version ?? attachment.sourceVersion ?? 0,
      revision: attachment.sourceRevision ?? attachment.contentRevision,
      ...(attachment.range ? { range: attachment.range } : {}),
      ...(attachment.side ? { side: attachment.side } : {}),
    },
    byteOrderMark: false,
    byteLength: Buffer.byteLength(attachment.text),
  }));
}
