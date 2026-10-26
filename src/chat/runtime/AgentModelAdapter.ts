import type { AgentMode } from '#src/chat/AgentMode.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ChatRequest } from '#src/chat/ChatRequest.js';
import type { Usage } from '#src/chat/Usage.js';
import type { AgentInstructionContext } from '#src/instructions/AgentInstructionSource.js';

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
  /** Host-generated identity shared by the model turn and every tool round it produces. */
  readonly turnId: string;
  readonly mode: AgentMode;
  readonly signal: AbortSignal;
  readonly round: number;
  /** Provider-neutral instructions prepared by the host for this boundary. */
  readonly instructionContext?: AgentInstructionContext;
  readonly onText: (delta: string) => void;
  readonly onReasoningSummary?: (delta: string) => void;
  readonly trace: (kind: string, data: unknown, round?: number) => void;
}

export interface InterruptedToolRecovery {
  readonly state: ChatProviderState;
  readonly recoveredCallCount: number;
}

/**
 * Provider protocol seam. Implementations translate provider wire state into
 * semantic model steps while AgentRuntime owns the host/tool lifecycle.
 */
export interface AgentModelAdapter<TTurn> {
  readonly model: string;
  emptyState(): ChatProviderState;
  restoreState(state: ChatProviderState): ChatProviderState;
  /** Settles durable tool intents that have no outcome, such as after process interruption. */
  recoverInterruptedToolCalls(state: ChatProviderState): InterruptedToolRecovery;
  recordContext(state: ChatProviderState, events: readonly ChatContextEvent[]): ChatProviderState;
  beginTurn(state: ChatProviderState, request: ChatRequest, context: AgentTurnContext): Promise<TTurn>;
  /** Apply accepted guidance to the current logical turn, preserving completed output and tool results.
   * Adapters own provider-specific delivery; this operation must not execute or cancel tools.
   */
  steerTurn(turn: TTurn, request: ChatRequest, context: AgentTurnContext): Promise<TTurn>;
  streamStep(turn: TTurn, context: AgentTurnContext): Promise<AgentTurnStep<TTurn>>;
  appendToolResults(turn: TTurn, results: readonly AgentToolResult[]): TTurn;
  commit(turn: TTurn): ChatProviderState;
}
