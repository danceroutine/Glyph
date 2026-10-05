import type { ProviderTraceEntry } from './ProviderTraceEntry.ts';
import type { ToolActivity } from './ToolActivity.ts';
import type { TurnResult } from './TurnResult.ts';

/** Low-level model/agent adapter. Hosts consume HarnessService instead. */
export interface ChatProvider {
  readonly model: string;
  reset(): void;
  send(text: string, options: {
    signal: AbortSignal;
    onText: (delta: string) => void;
    onTrace?: (entry: ProviderTraceEntry) => void;
    onToolActivity?: (activity: ToolActivity) => void;
  }): Promise<TurnResult>;
}
