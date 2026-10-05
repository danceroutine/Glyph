import type { AuthorizationHandler } from './AuthorizationHandler.ts';
import type { OpenAIAccount } from './OpenAIAccount.ts';

export interface OpenAISessionService {
  signIn(existing?: OpenAIAccount, consent?: boolean, authorize?: AuthorizationHandler): Promise<OpenAIAccount>;
  accessToken(account: OpenAIAccount): Promise<string>;
  logout(account: OpenAIAccount): Promise<boolean>;
  redact(message: string): string;
}
