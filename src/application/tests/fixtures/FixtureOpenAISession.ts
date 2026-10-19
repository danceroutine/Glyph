import type { OpenAIAccount } from '#src/providers/openai/auth/OpenAIAccount.js';
import type { OpenAISessionService } from '#src/providers/openai/auth/OpenAISessionService.js';

export class FixtureOpenAISession implements OpenAISessionService {
  constructor(private readonly account: OpenAIAccount) {}
  async dispose(): Promise<void> {}
  async signIn(): Promise<OpenAIAccount> {
    return this.account;
  }
  async accessToken(): Promise<string> {
    return 'sentinel-not-a-real-token';
  }
  async logout(): Promise<boolean> {
    return true;
  }
  redact(message: string): string {
    return message.replaceAll('sentinel-not-a-real-token', '[REDACTED]');
  }
}
