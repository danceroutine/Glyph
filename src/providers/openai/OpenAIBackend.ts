import type { ChatAccount } from '../../chat/ChatAccount.ts';
import type { ChatAuthorizationHandler } from '../../chat/ChatAuthorizationRequest.ts';
import type { ChatBackend } from '../../chat/ChatBackend.ts';
import type { ChatProvider } from '../../chat/ChatProvider.ts';
import type { ChatProviderFactory } from '../../chat/ChatProviderFactory.ts';
import type { ChatProviderState } from '../../chat/ChatProviderState.ts';
import type { Model } from '../../chat/Model.ts';
import type { ModelCatalog } from '../../chat/ModelCatalog.ts';
import { AuthenticationError } from '../../errors/AuthenticationError.ts';
import type { OpenAIConfiguration } from './OpenAIConfiguration.ts';
import type { OpenAIAccount } from './auth/OpenAIAccount.ts';
import type { OpenAIAccountStore } from './auth/OpenAIAccountStore.ts';
import type { OpenAISessionService } from './auth/OpenAISessionService.ts';

const providerId = 'openai';

/** OpenAI-specific composition kept behind the provider-neutral application boundary. */
export class OpenAIBackend implements ChatBackend {
  readonly presentation = {
    name: 'ChatGPT',
    welcome: 'Glyph | Continue with ChatGPT',
    usageDescription:
      'Uses your plan allowance and any credits you authorize in ChatGPT settings.\nUsage controls: https://chatgpt.com/settings/usage',
    accountsHeading: 'ChatGPT accounts',
    addAccountLabel: 'Add another account/workspace',
    activeAccessLabel: 'ChatGPT plan',
  } as const;

  private acquired = false;

  constructor(
    private readonly store: OpenAIAccountStore,
    private readonly session: OpenAISessionService,
    private readonly models: ModelCatalog,
    private readonly providers: ChatProviderFactory,
    private readonly configuration: OpenAIConfiguration,
  ) {}

  get accounts(): readonly ChatAccount[] {
    return this.store.state.accounts.map(account => this.toAccount(account));
  }

  async initialize(): Promise<void> {
    if (this.acquired) return;
    await this.store.acquire();
    this.acquired = true;
    try {
      await this.store.load();
    } catch (error) {
      this.acquired = false;
      try {
        await this.store.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Account initialization failed and cleanup was incomplete.');
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;
    await this.store.release();
  }

  async signIn(
    existing?: ChatAccount,
    options: { readonly requestInferenceAccess?: boolean } = {},
    authorize?: ChatAuthorizationHandler,
  ): Promise<ChatAccount> {
    const account = await this.session.signIn(
      existing ? this.resolve(existing) : undefined,
      options.requestInferenceAccess ?? false,
      authorize
        ? request =>
            authorize({
              url: request.url,
              title: 'Continue with ChatGPT',
              message: 'Authorize Glyph to use your ChatGPT plan.',
            })
        : undefined,
    );
    return this.toAccount(account);
  }

  async acknowledgeNotice(account: ChatAccount): Promise<void> {
    const value = this.resolve(account);
    if (value.planNoticeSeen) return;
    value.planNoticeSeen = true;
    await this.store.save();
  }

  async listModels(account: ChatAccount): Promise<Model[]> {
    const value = this.resolve(account);
    if (!this.hasInferenceAccess(value)) {
      throw new AuthenticationError('Sign-in completed, but ChatGPT plan usage was not granted.');
    }
    return this.models.list(await this.session.accessToken(value));
  }

  createProvider(account: ChatAccount, model: Model, state?: ChatProviderState): ChatProvider {
    const value = this.resolve(account);
    const token = (): Promise<string> => this.session.accessToken(value);
    return state ? this.providers.create(model.slug, token, state) : this.providers.create(model.slug, token);
  }

  logout(account: ChatAccount): Promise<boolean> {
    return this.session.logout(this.resolve(account));
  }

  redact(message: string): string {
    return this.session.redact(message);
  }

  private toAccount(account: OpenAIAccount): ChatAccount {
    return {
      provider: providerId,
      id: accountId(account),
      label: account.email,
      detail: account.clientId,
      connected: account.tokens !== undefined,
      inferenceAccess: this.hasInferenceAccess(account),
      accessPrompt: 'Enable ChatGPT plan usage for this account?',
      ...(account.planNoticeSeen
        ? {}
        : {
            notice: {
              message:
                "You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage",
              acknowledgementPrompt: 'Got it [Enter]: ',
              url: 'https://chatgpt.com/settings/usage',
            },
          }),
    };
  }

  private resolve(account: ChatAccount): OpenAIAccount {
    if (account.provider !== providerId) throw new AuthenticationError('This account belongs to another provider.');
    const value = this.store.state.accounts.find(candidate => accountId(candidate) === account.id);
    if (!value) throw new AuthenticationError('This account is no longer registered.');
    return value;
  }

  private hasInferenceAccess(account: OpenAIAccount): boolean {
    return account.tokens?.scopes.includes(this.configuration.planScope) ?? false;
  }
}

function accountId(account: OpenAIAccount): string {
  return JSON.stringify([account.clientId, account.subject]);
}
