import type { Usage } from './Usage.ts';

export interface TurnResult {
  usage: Usage | null;
  responseId: string;
}
