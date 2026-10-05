import type { AuthorizationHandler } from './AuthorizationHandler.ts';
import type { OpenAIAccount } from './OpenAIAccount.ts';

/** Authentication-session port consumed by the provider-neutral application service. */
export interface OpenAISessionService {
  signIn(existing?: OpenAIAccount, consent?: boolean, authorize?: AuthorizationHandler): Promise<OpenAIAccount>;
  accessToken(account: OpenAIAccount): Promise<string>;
  logout(account: OpenAIAccount): Promise<boolean>;
  redact(message: string): string;
}
