import { ChatConversation } from '../chat/ChatConversation.ts';
import type { ChatAccount } from '../chat/ChatAccount.ts';
import type { ChatAuthorizationHandler } from '../chat/ChatAuthorizationRequest.ts';
import type { ChatBackend, ChatBackendPresentation } from '../chat/ChatBackend.ts';
import type { Model } from '../chat/Model.ts';
import type { TurnResult } from '../chat/TurnResult.ts';
import type { Usage } from '../chat/Usage.ts';
import type { Logger } from '../observability/Logger.ts';
import type { ProposalReviewManager } from '../editing/reviews/ProposalReviewManager.ts';
import type { ChatRequest } from '../chat/ChatRequest.ts';
import type { ContextAttachmentReference } from '../context/attachments/ContextAttachmentReference.ts';
import type { ContextAttachmentService } from '../context/attachments/ContextAttachmentService.ts';
import type { WorkspacePathIndex } from '../context/search/WorkspacePathIndex.ts';
import type { ChatProviderState } from '../chat/ChatProviderState.ts';
import type { ChatSession } from '../chat/sessions/ChatSession.ts';
import type { ChatSessionManager } from '../chat/sessions/ChatSessionManager.ts';
import type { ChatSessionSummary } from '../chat/sessions/ChatSessionRecord.ts';
import type { ChatContextEvent } from '../chat/ChatContextEvent.ts';

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

  async initialize(): Promise<void> {
    if (this.acquired) return;
    await this.backend.initialize();
    this.acquired = true;
    let pathIndexStarted = false;
    let chatSessionsStarted = false;
    try {
      chatSessionsStarted = this.chatSessions !== undefined;
      await this.chatSessions?.initialize();
      await this.proposalReviews?.initialize();
      pathIndexStarted = this.pathIndex !== undefined;
      await this.pathIndex?.initialize();
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
        );
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
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

  async listModels(account: ChatAccount): Promise<Model[]> {
    return this.backend.listModels(account);
  }

  createConversation(account: ChatAccount, model: Model): ChatConversation {
    return this.instantiateConversation(account, model);
  }

  async commitReviewResults(conversation: {
    readonly id?: string;
    recordContext(events: readonly ChatContextEvent[]): void | Promise<void>;
  }): Promise<void> {
    if (!this.proposalReviews || this.proposalReviews.pendingResults.length === 0) return;
    const results = this.proposalReviews.pendingResults;
    const groups = new Map<string, typeof results>();
    for (const result of results) {
      const key = result.origin
        ? JSON.stringify([result.origin.accountProvider, result.origin.accountId, result.origin.chatId])
        : 'legacy';
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
    for (const group of groups.values()) {
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
      await this.proposalReviews.acknowledgeResults(group.map(result => result.id));
    }
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
    return this.requireChatSessions().open(identifier, record => {
      if (record.accountProvider !== account.provider || record.accountId !== account.id) {
        throw new Error('That chat belongs to a different provider account or workspace.');
      }
      return this.instantiateConversation(
        account,
        { slug: record.modelSlug, name: record.modelName },
        record.providerState,
      );
    });
  }

  renameChat(identifier: string, title: string): Promise<ChatSessionSummary> {
    return this.requireChatSessions().rename(identifier, title);
  }

  private instantiateConversation(account: ChatAccount, model: Model, state?: ChatProviderState): ChatConversation {
    const provider = this.backend.createProvider(account, model, state);
    return new ChatConversation(
      provider,
      this.logger,
      value => this.backend.redact(value),
      result => this.recordUsage(result),
      this.traceEnabled,
    );
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

  private recordUsage(result: TurnResult): void {
    if (!result.usage) return;
    for (const key of Object.keys(this.aggregateUsage) as (keyof Usage)[]) {
      this.aggregateUsage[key] += result.usage[key];
    }
  }

  private requireChatSessions(): ChatSessionManager {
    if (!this.chatSessions) throw new Error('This host does not support persistent chat sessions.');
    return this.chatSessions;
  }
}
