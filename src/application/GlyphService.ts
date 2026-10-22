import { AgentModeID } from '#src/chat/AgentMode.js';
import type { PlanUpdate } from '#src/planning/PlanSchema.js';
import { PlanError } from '#src/planning/PlanError.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { ChatAuthorizationHandler } from '#src/chat/ChatAuthorizationRequest.js';
import type { ChatBackend, ChatBackendPresentation } from '#src/chat/ChatBackend.js';
import type { Model } from '#src/chat/Model.js';
import type { TurnResult } from '#src/chat/TurnResult.js';
import type { Usage } from '#src/chat/Usage.js';
import type { Logger } from '#src/observability/Logger.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { ChatRequest } from '#src/chat/ChatRequest.js';
import type { ContextAttachmentReference } from '#src/context/attachments/ContextAttachmentReference.js';
import type { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionSummary } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';

interface ReviewResultDestination {
  readonly id?: string;
  recordContext(events: readonly ChatContextEvent[]): void | Promise<void>;
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

/**
 * Headless application service. It owns authentication/model/conversation
 * behavior plus shared workspace-context lifecycle, but knows nothing about
 * readline, console output, commands, or VS Code. Hosts drive it one operation
 * and one request at a time.
 */
export class GlyphService {
  private readonly aggregateUsage = emptyUsage();
  private acquired = false;
  private traceEnabled: boolean;
  private readonly reviewDeliveries = new Set<Promise<void>>();

  constructor(
    private readonly backend: ChatBackend,
    private readonly logger: Logger,
    options: { traceEnabled?: boolean } = {},
    readonly proposalReviews?: ProposalReviewManager,
    private readonly contextAttachments?: ContextAttachmentService,
    private readonly pathIndex?: WorkspacePathIndex,
    private readonly chatSessions?: ChatSessionManager,
  ) {
    this.traceEnabled = options.traceEnabled ?? true;
  }

  setChatMode(id: string, mode: AgentModeID): Promise<ChatSessionSummary> {
    if (!this.chatSessions) throw new PlanError('Chat storage is unavailable.');
    return this.chatSessions.setMode(id, mode);
  }

  linkPlan(
    chatId: string,
    planId: string,
    targetChatId: string,
    role: 'Builder' | 'Reviewer',
  ): Promise<ChatSessionSummary> {
    if (!this.chatSessions) throw new PlanError('Plan storage is unavailable.');
    return this.chatSessions.linkPlan(chatId, planId, targetChatId, role);
  }

  updatePlan(chat: ChatSessionSummary, update: PlanUpdate): Promise<ChatSessionSummary> {
    if (!this.chatSessions) throw new PlanError('Plan storage is unavailable.');
    return this.chatSessions.updatePlan(chat, update);
  }

  get accounts(): readonly ChatAccount[] {
    return this.backend.accounts;
  }
  get providerPresentation(): ChatBackendPresentation {
    return this.backend.presentation;
  }
  get tracePath(): string | undefined {
    return this.logger.destination;
  }
  get isTraceEnabled(): boolean {
    return this.traceEnabled;
  }
  get usage(): Usage {
    return { ...this.aggregateUsage };
  }

  async initialize({ workspaceTrusted = true }: { workspaceTrusted?: boolean } = {}): Promise<void> {
    if (this.acquired) return;
    await this.backend.initialize();
    this.acquired = true;
    let pathIndexStarted = false;
    let chatSessionsStarted = false;
    try {
      chatSessionsStarted = this.chatSessions !== undefined;
      await this.chatSessions?.initialize();
      await this.proposalReviews?.initialize({ reconcileWorkspace: workspaceTrusted });
      // Untrusted desktop runtimes expose persisted conversations only. Native
      // indexing and recovery reads begin in the replacement trusted runtime.
      if (workspaceTrusted) {
        pathIndexStarted = this.pathIndex !== undefined;
        await this.pathIndex?.initialize();
      }
    } catch (error) {
      this.acquired = false;
      const cleanupFailures: unknown[] = [];
      if (pathIndexStarted) {
        try {
          await this.pathIndex?.dispose();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (chatSessionsStarted) {
        try {
          await this.chatSessions?.dispose();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await this.backend.dispose();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          'Glyph initialization failed and resource cleanup was incomplete.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
    // Cancelling a turn releases its waiter, but an admitted receipt save must
    // settle before its chat store closes. Failed deliveries remain retryable.
    await Promise.allSettled(this.reviewDeliveries);
    try {
      await this.pathIndex?.dispose();
    } finally {
      try {
        await this.chatSessions?.dispose();
      } finally {
        await this.backend.dispose();
      }
    }
  }

  hasInferenceAccess(account: ChatAccount): boolean {
    return account.inferenceAccess;
  }

  async signIn(
    existing?: ChatAccount,
    requestInferenceAccess = false,
    authorize?: ChatAuthorizationHandler,
  ): Promise<ChatAccount> {
    return this.backend.signIn(existing, { requestInferenceAccess }, authorize);
  }

  async acknowledgeAccountNotice(account: ChatAccount): Promise<void> {
    await this.backend.acknowledgeNotice(account);
  }

  async listModels(account: ChatAccount, signal?: AbortSignal): Promise<Model[]> {
    return this.backend.listModels(account, signal);
  }

  createConversation(account: ChatAccount, model: Model): ChatConversation {
    return this.instantiateConversation(account, model);
  }

  /** Concurrent hosts deliver only the current chat's receipts; terminal review can drain all owners. */
  async commitReviewResults(
    conversation: ReviewResultDestination,
    options: { readonly currentChatOnly?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal, currentChatOnly = false } = options;
    signal?.throwIfAborted();
    if (currentChatOnly && (conversation.id === undefined || conversation.id === ''))
      throw new Error('Chat-scoped review delivery requires a chat id.');
    const delivery = this.deliverReviewResults(conversation, currentChatOnly, signal);
    this.reviewDeliveries.add(delivery);
    const settled = () => {
      this.reviewDeliveries.delete(delivery);
    };
    void delivery.then(settled, settled);
    if (!signal) return delivery;
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void delivery.then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        error => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }

  listChats(account?: ChatAccount): readonly ChatSessionSummary[] {
    return this.requireChatSessions().list(account);
  }

  async createChat(account: ChatAccount, model: Model): Promise<ChatSession> {
    const conversation = this.instantiateConversation(account, model);
    return this.requireChatSessions().create(
      {
        accountProvider: account.provider,
        accountId: account.id,
        modelSlug: model.slug,
        modelName: model.name,
      },
      conversation,
    );
  }

  openChat(identifier: string, account: ChatAccount): ChatSession {
    return this.requireChatSessions().open(
      identifier,
      record =>
        this.instantiateConversation(account, { slug: record.modelSlug, name: record.modelName }, record.providerState),
      record => {
        if (record.accountProvider !== account.provider || record.accountId !== account.id) {
          throw new Error('That chat belongs to a different provider account or workspace.');
        }
      },
    );
  }

  branchChat(identifier: string, turnId: string, account: ChatAccount): Promise<ChatSession> {
    const session = this.openChat(identifier, account);
    return this.requireChatSessions().branch(session, turnId, record =>
      this.instantiateConversation(account, { slug: record.modelSlug, name: record.modelName }, record.providerState),
    );
  }

  renameChat(identifier: string, title: string): Promise<ChatSessionSummary> {
    return this.requireChatSessions().rename(identifier, title);
  }

  /** Resolves user-selected paths at send time so providers receive fresh, authorized snapshots. */
  async resolveChatRequest(text: string, references: readonly ContextAttachmentReference[] = []): Promise<ChatRequest> {
    if (references.length === 0) return { text, attachments: [] };
    if (!this.contextAttachments) throw new Error('This host does not support workspace context attachments.');
    return { text, attachments: await this.contextAttachments.resolve(references) };
  }

  setTraceEnabled(enabled: boolean): void {
    this.traceEnabled = enabled;
  }

  async logout(account: ChatAccount): Promise<boolean> {
    return this.backend.logout(account);
  }

  redact(message: string): string {
    return this.backend.redact(message);
  }

  private async deliverReviewResults(
    conversation: ReviewResultDestination,
    currentChatOnly: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.proposalReviews) return;
    await this.proposalReviews.flushPendingCheckpoint();
    signal?.throwIfAborted();
    // Foreign receipts stay pending for their owner. Legacy receipts without an
    // owner require explicit workspace-wide delivery, never a guessed chat.
    // Another chat's active tool/question cannot gate this turn.
    const results = this.proposalReviews.pendingResults.filter(
      result => !currentChatOnly || result.origin?.chatId === conversation.id,
    );
    const groups = new Map<string, typeof results>();
    for (const result of results) {
      const key = result.origin
        ? JSON.stringify([result.origin.accountProvider, result.origin.accountId, result.origin.chatId])
        : 'legacy';
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
    for (const group of groups.values()) {
      signal?.throwIfAborted();
      const origin = group[0]?.origin;
      let destination = conversation;
      if (origin && conversation.id !== origin.chatId) {
        const account = this.backend.accounts.find(
          candidate => candidate.provider === origin.accountProvider && candidate.id === origin.accountId,
        );
        if (!account) throw new Error('The proposal owner account is no longer available.');
        destination = this.openChat(origin.chatId, account);
      }
      await destination.recordContext(
        group.map(result => ({
          schemaVersion: 1,
          id: result.id,
          type: 'edit_review_result',
          payload: result,
        })),
      );
      // Once dispatched, complete the receipt handshake even if its caller
      // stops waiting: acknowledge only after chat history is durably saved.
      await this.proposalReviews.acknowledgeResults(group.map(result => result.id));
    }
  }

  private instantiateConversation(account: ChatAccount, model: Model, state?: ChatProviderState): ChatConversation {
    const provider = this.backend.createProvider(account, model, state);
    return new ChatConversation(
      provider,
      this.logger,
      value => this.backend.redact(value),
      result => {
        this.recordUsage(result);
      },
      this.traceEnabled,
    );
  }

  private recordUsage(result: TurnResult): void {
    if (!result.usage) return;
    const { usage } = result;
    this.aggregateUsage.inputTokens += usage.inputTokens;
    this.aggregateUsage.cachedInputTokens += usage.cachedInputTokens;
    this.aggregateUsage.outputTokens += usage.outputTokens;
    this.aggregateUsage.reasoningTokens += usage.reasoningTokens;
    this.aggregateUsage.totalTokens += usage.totalTokens;
  }

  private requireChatSessions(): ChatSessionManager {
    if (!this.chatSessions) throw new Error('This host does not support persistent chat sessions.');
    return this.chatSessions;
  }
}
