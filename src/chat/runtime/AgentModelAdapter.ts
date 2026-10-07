import type { ChatContextEvent } from '../ChatContextEvent.ts';
import type { ChatProviderState } from '../ChatProviderState.ts';
import type { ChatRequest } from '../ChatRequest.ts';
import type { Usage } from '../Usage.ts';

export interface AgentToolCall {
  readonly id: string;
  readonly namespace?: string;
  readonly name: string;
  readonly input: string;
  /** Provider-owned information needed to encode the corresponding result. */
  readonly protocolData?: unknown;
}

export interface AgentToolResult {
  readonly call: AgentToolCall;
  readonly output: string;
}

export interface AgentTurnStep<TTurn> {
  readonly turn: TTurn;
  readonly responseId: string;
  readonly usage: Usage | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly hasVisibleOutput: boolean;
}

export interface AgentTurnContext {
  readonly signal: AbortSignal;
  readonly round: number;
  readonly onText: (delta: string) => void;
  readonly onReasoningSummary?: (delta: string) => void;
  readonly trace: (kind: string, data: unknown, round?: number) => void;
}

/**
 * Provider protocol seam. Implementations translate provider wire state into
 * semantic model steps while AgentRuntime owns the host/tool lifecycle.
 */
export interface AgentModelAdapter<TTurn> {
  readonly model: string;
  emptyState(): ChatProviderState;
  restoreState(state: ChatProviderState): ChatProviderState;
  recordContext(state: ChatProviderState, events: readonly ChatContextEvent[]): ChatProviderState;
  beginTurn(state: ChatProviderState, request: ChatRequest, context: AgentTurnContext): Promise<TTurn>;
  streamStep(turn: TTurn, context: AgentTurnContext): Promise<AgentTurnStep<TTurn>>;
  appendToolResults(turn: TTurn, results: readonly AgentToolResult[]): TTurn;
  commit(turn: TTurn): ChatProviderState;
}
