import type { OpenAIAccount } from '../../../providers/openai/auth/OpenAIAccount.ts';
import type { OpenAISessionService } from '../../../providers/openai/auth/OpenAISessionService.ts';

export class FixtureOpenAISession implements OpenAISessionService {
  constructor(private readonly account: OpenAIAccount) {}
  async signIn(): Promise<OpenAIAccount> { return this.account; }
  async accessToken(): Promise<string> { return 'sentinel-not-a-real-token'; }
  async logout(): Promise<boolean> { return true; }
  redact(message: string): string { return message.replaceAll('sentinel-not-a-real-token', '[REDACTED]'); }
}
