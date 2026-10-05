import type { OpenAITokens } from './OpenAITokens.ts';

export interface OpenAIAccount {
  clientId: string;
  subject: string;
  email: string;
  tokens?: OpenAITokens;
  planNoticeSeen?: boolean;
}
