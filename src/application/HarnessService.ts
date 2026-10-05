import { ChatConversation } from '../chat/ChatConversation.ts';
import type { ChatProviderFactory } from '../chat/ChatProviderFactory.ts';
import type { Model } from '../chat/Model.ts';
import type { ModelCatalog } from '../chat/ModelCatalog.ts';
import type { TurnResult } from '../chat/TurnResult.ts';
import type { Usage } from '../chat/Usage.ts';
import { AuthenticationError } from '../errors/AuthenticationError.ts';
import type { Logger } from '../observability/Logger.ts';
import type { EditSessionManager } from '../editing/EditSessionManager.ts';
import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { AuthorizationHandler } from '../providers/openai/auth/AuthorizationHandler.ts';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import type { OpenAIAccountStore } from '../providers/openai/auth/OpenAIAccountStore.ts';
import type { OpenAISessionService } from '../providers/openai/auth/OpenAISessionService.ts';

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

/**
 * Headless application service. It owns authentication/model/conversation
 * behavior, but knows nothing about readline, console output, commands, or VS
 * Code. Hosts drive it one operation and one request at a time.
 */
export class HarnessService {
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
    readonly edits?: EditSessionManager,
  ) {
    this.traceEnabled = options.traceEnabled ?? true;
  }

  get accounts(): readonly OpenAIAccount[] { return this.store.state.accounts; }
  get tracePath(): string | undefined { return this.logger.destination; }
  get isTraceEnabled(): boolean { return this.traceEnabled; }
  get usage(): Usage { return { ...this.aggregateUsage }; }

  async initialize(): Promise<void> {
    if (this.acquired) return;
    await this.store.acquire();
    this.acquired = true;
    await this.store.load();
    await this.edits?.initialize();
  }

  async dispose(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
    await this.store.release();
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
    const provider = this.providers.create(model.slug, () => this.session.accessToken(account));
    return new ChatConversation(
      provider,
      this.logger,
      value => this.session.redact(value),
      result => this.recordUsage(result),
      this.traceEnabled,
    );
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
}
