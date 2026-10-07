import { ChatConversation } from '../chat/ChatConversation.ts';
import type { ChatProviderFactory } from '../chat/ChatProviderFactory.ts';
import type { Model } from '../chat/Model.ts';
import type { ModelCatalog } from '../chat/ModelCatalog.ts';
import type { TurnResult } from '../chat/TurnResult.ts';
import type { Usage } from '../chat/Usage.ts';
import { AuthenticationError } from '../errors/AuthenticationError.ts';
import type { Logger } from '../observability/Logger.ts';
import type { ProposalReviewManager } from '../editing/reviews/ProposalReviewManager.ts';
import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { AuthorizationHandler } from '../providers/openai/auth/AuthorizationHandler.ts';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import type { OpenAIAccountStore } from '../providers/openai/auth/OpenAIAccountStore.ts';
import type { OpenAISessionService } from '../providers/openai/auth/OpenAISessionService.ts';
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
    private readonly store: OpenAIAccountStore,
    private readonly session: OpenAISessionService,
    private readonly models: ModelCatalog,
    private readonly providers: ChatProviderFactory,
    private readonly logger: Logger,
    private readonly openAI: OpenAIConfiguration,
    options: { traceEnabled?: boolean } = {},
    readonly proposalReviews?: ProposalReviewManager,
    private readonly contextAttachments?: ContextAttachmentService,
    private readonly pathIndex?: WorkspacePathIndex,
    private readonly chatSessions?: ChatSessionManager,
  ) {
    this.traceEnabled = options.traceEnabled ?? true;
  }

  get accounts(): readonly OpenAIAccount[] {
    return this.store.state.accounts;
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
    await this.store.acquire();
    this.acquired = true;
    let pathIndexStarted = false;
    let chatSessionsStarted = false;
    try {
      await this.store.load();
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
        await this.store.release();
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
        await this.store.release();
      }
    }
  }

  hasPlanAccess(account: OpenAIAccount): boolean {
    return account.tokens?.scopes.includes(this.openAI.planScope) ?? false;
  }

  async signIn(existing?: OpenAIAccount, consent = false, authorize?: AuthorizationHandler): Promise<OpenAIAccount> {
    return this.session.signIn(existing, consent, authorize);
  }

  async acknowledgePlanNotice(account: OpenAIAccount): Promise<void> {
    if (account.planNoticeSeen) return;
    account.planNoticeSeen = true;
    await this.store.save();
  }

  async listModels(account: OpenAIAccount): Promise<Model[]> {
    if (!this.hasPlanAccess(account)) {
      throw new AuthenticationError('Sign-in completed, but ChatGPT plan usage was not granted.');
    }
    return this.models.list(await this.session.accessToken(account));
  }

  createConversation(account: OpenAIAccount, model: Model): ChatConversation {
    return this.instantiateConversation(account, model);
  }

  async commitReviewResults(conversation: {
    recordContext(events: readonly ChatContextEvent[]): void | Promise<void>;
  }): Promise<void> {
    if (!this.proposalReviews || this.proposalReviews.pendingResults.length === 0) return;
    const results = this.proposalReviews.pendingResults;
    await conversation.recordContext(
      results.map(result => ({
        schemaVersion: 1,
        id: result.id,
        type: 'edit_review_result',
        payload: result,
      })),
    );
    await this.proposalReviews.acknowledgeResults(results.map(result => result.id));
  }

  listChats(account?: OpenAIAccount): readonly ChatSessionSummary[] {
    return this.requireChatSessions().list(account);
  }

  async createChat(account: OpenAIAccount, model: Model): Promise<ChatSession> {
    const conversation = this.instantiateConversation(account, model);
    return this.requireChatSessions().create(
      {
        accountClientId: account.clientId,
        accountSubject: account.subject,
        modelSlug: model.slug,
        modelName: model.name,
      },
      conversation,
    );
  }

  openChat(identifier: string, account: OpenAIAccount): ChatSession {
    return this.requireChatSessions().open(identifier, record => {
      if (record.accountClientId !== account.clientId || record.accountSubject !== account.subject) {
        throw new Error('That chat belongs to a different ChatGPT account or workspace.');
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

  private instantiateConversation(account: OpenAIAccount, model: Model, state?: ChatProviderState): ChatConversation {
    const token = (): Promise<string> => this.session.accessToken(account);
    const provider = state ? this.providers.create(model.slug, token, state) : this.providers.create(model.slug, token);
    return new ChatConversation(
      provider,
      this.logger,
      value => this.session.redact(value),
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

  async logout(account: OpenAIAccount): Promise<boolean> {
    return this.session.logout(account);
  }

  redact(message: string): string {
    return this.session.redact(message);
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
