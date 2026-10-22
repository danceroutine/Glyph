import type { ChatRequest } from '#src/chat/ChatRequest.js';
import type { Logger } from '#src/observability/Logger.js';
import { ProviderError } from '#src/errors/ProviderError.js';
import type { ChatProvider } from './ChatProvider.ts';
import { ChatResponsePartType } from './ChatResponsePartType.ts';
import type { ChatResponseStream } from './ChatResponseStream.ts';
import type { ChatTurnResult } from './ChatTurnResult.ts';
import { DiagnosticSeverity } from './DiagnosticSeverity.ts';
import type { ProviderTraceEntry } from './ProviderTraceEntry.ts';
import type { TurnResult } from './TurnResult.ts';
import type { ChatRequestInput } from './ChatRequest.ts';
import type { ChatProviderState } from './ChatProviderState.ts';
import type { ChatContextEvent } from './ChatContextEvent.ts';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';

export interface ChatConversationSendOptions {
  readonly takeSteering?: (finishing: boolean) => readonly ChatRequest[];
  readonly onStateCheckpoint?: (state: ChatProviderState) => void | Promise<void>;
  readonly toolContext?: ToolExecutionContext;
}

/** Mutable history for one host-owned chat session. */
export class ChatConversation {
  private traceEnabled: boolean;

  constructor(
    private readonly provider: ChatProvider,
    private readonly logger: Logger,
    private readonly redact: (value: string) => string,
    private readonly recordUsage: (result: TurnResult) => void,
    traceEnabled: boolean,
  ) {
    this.traceEnabled = traceEnabled;
  }

  get model(): string {
    return this.provider.model;
  }
  get isTraceEnabled(): boolean {
    return this.traceEnabled;
  }

  exportState(): ChatProviderState {
    return this.provider.exportState();
  }

  recordContext(events: readonly ChatContextEvent[]): void {
    this.provider.recordContext(events);
  }

  restoreState(state: ChatProviderState): void {
    this.provider.restoreState(state);
  }

  reset(): void {
    this.provider.reset();
  }

  setTraceEnabled(enabled: boolean): void {
    this.traceEnabled = enabled;
  }

  async send(
    request: ChatRequestInput,
    response: ChatResponseStream,
    signal: AbortSignal,
    options: ChatConversationSendOptions = {},
  ): Promise<ChatTurnResult> {
    const trace: ProviderTraceEntry[] = [];
    const startedAt = performance.now();
    let result: TurnResult | undefined;
    let failed = false;
    let failure: unknown;

    try {
      result = await this.provider.send(request, {
        signal,
        onText: value => {
          response.push({ type: ChatResponsePartType.TEXT, value });
        },
        onReasoningSummary: value => {
          response.push({ type: ChatResponsePartType.REASONING_SUMMARY, value });
        },
        onToolActivity: activity => {
          response.push({ type: ChatResponsePartType.TOOL, activity });
        },
        onTrace: entry => {
          if (this.traceEnabled) trace.push(entry);
        },
        ...(options.onStateCheckpoint ? { onStateCheckpoint: options.onStateCheckpoint } : {}),
        ...(options.takeSteering ? { takeSteering: options.takeSteering } : {}),
        ...(options.toolContext ? { toolContext: options.toolContext } : {}),
      });
    } catch (error) {
      failed = true;
      failure = error;
    }

    if (this.traceEnabled) {
      try {
        await this.logger.trace('provider.trace', JSON.parse(this.redact(JSON.stringify(trace))) as unknown);
      } catch (error) {
        response.push({
          type: ChatResponsePartType.DIAGNOSTIC,
          severity: DiagnosticSeverity.ERROR,
          message: `Trace log write failed: ${this.redact(error instanceof Error ? error.message : String(error))}`,
        });
      }
    }

    if (failed) throw failure;
    if (!result) throw new ProviderError('Provider completed without a result.');
    this.recordUsage(result);
    return {
      ...result,
      durationMs: performance.now() - startedAt,
    };
  }
}
