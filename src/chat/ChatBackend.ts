import type { ChatProvider } from './ChatProvider.ts';
import type { ChatProviderState } from './ChatProviderState.ts';
import type { Model } from './Model.ts';
import type { ChatAccount } from './ChatAccount.ts';
import type { ChatAuthorizationHandler } from './ChatAuthorizationRequest.ts';

export interface ChatBackendPresentation {
  readonly name: string;
  readonly welcome: string;
  readonly usageDescription: string;
  readonly accountsHeading: string;
  readonly addAccountLabel: string;
  readonly activeAccessLabel: string;
}

/**
 * Complete account/model/conversation boundary implemented by one provider.
 * Credentials and provider-specific account records never cross this port.
 */
export interface ChatBackend {
  readonly presentation: ChatBackendPresentation;
  readonly accounts: readonly ChatAccount[];
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  signIn(
    existing?: ChatAccount,
    options?: { readonly requestInferenceAccess?: boolean },
    authorize?: ChatAuthorizationHandler,
  ): Promise<ChatAccount>;
  acknowledgeNotice(account: ChatAccount): Promise<void>;
  listModels(account: ChatAccount): Promise<Model[]>;
  createProvider(account: ChatAccount, model: Model, state?: ChatProviderState): ChatProvider;
  logout(account: ChatAccount): Promise<boolean>;
  redact(message: string): string;
}
