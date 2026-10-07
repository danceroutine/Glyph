import type { ProviderTraceEntry } from './ProviderTraceEntry.ts';
import type { ToolActivity } from './ToolActivity.ts';
import type { TurnResult } from './TurnResult.ts';
import type { ChatRequestInput } from './ChatRequest.ts';
import type { ChatProviderState } from './ChatProviderState.ts';
import type { ChatContextEvent } from './ChatContextEvent.ts';
import type { ToolExecutionContext } from '../tools/ToolExecutionContext.ts';

/** Low-level model/agent adapter. Hosts consume GlyphService instead. */
export interface ChatProvider {
  readonly model: string;
  /** Commits host context immediately and ignores event IDs already present. */
  recordContext(events: readonly ChatContextEvent[]): void;
  exportState(): ChatProviderState;
  restoreState(state: ChatProviderState): void;
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
      /** Persists side-effecting tool rounds before the model is allowed to continue. */
      onStateCheckpoint?: (state: ChatProviderState) => void | Promise<void>;
      toolContext?: ToolExecutionContext;
    },
  ): Promise<TurnResult>;
}
