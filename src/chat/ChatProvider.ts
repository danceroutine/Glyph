import type { ProviderTraceEntry } from './ProviderTraceEntry.ts';
import type { ToolActivity } from './ToolActivity.ts';
import type { TurnResult } from './TurnResult.ts';
import type { ChatRequestInput } from './ChatRequest.ts';

/** Low-level model/agent adapter. Hosts consume GlyphService instead. */
export interface ChatProvider {
  readonly model: string;
  reset(): void;
  send(
    request: ChatRequestInput,
    options: {
      signal: AbortSignal;
      onText: (delta: string) => void;
      /** Receives provider-authored summaries, never a model's raw hidden reasoning. */
      onReasoningSummary?: (delta: string) => void;
      onTrace?: (entry: ProviderTraceEntry) => void;
      onToolActivity?: (activity: ToolActivity) => void;
    },
  ): Promise<TurnResult>;
}
