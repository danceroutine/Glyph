import type { ResponseOutputItem } from 'openai/resources/responses/responses';

export interface ScriptedResponseRound {
  readonly id: string;
  readonly output: ResponseOutputItem[];
  readonly status?: 'completed' | 'failed' | 'cancelled';
  readonly error?: { code: string; message: string };
  readonly validate?: (request: Record<string, unknown>) => void;
}
