import type { Logger } from '../observability/Logger.ts';
import { ProviderError } from '../errors/ProviderError.ts';
import type { ChatProvider } from './ChatProvider.ts';
import { ChatResponsePartType } from './ChatResponsePartType.ts';
import type { ChatResponseStream } from './ChatResponseStream.ts';
import type { ChatTurnResult } from './ChatTurnResult.ts';
import { DiagnosticSeverity } from './DiagnosticSeverity.ts';
import type { ProviderTraceEntry } from './ProviderTraceEntry.ts';
import type { TurnResult } from './TurnResult.ts';

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

  get model(): string { return this.provider.model; }
  get isTraceEnabled(): boolean { return this.traceEnabled; }

  reset(): void {
    this.provider.reset();
  }

  setTraceEnabled(enabled: boolean): void {
    this.traceEnabled = enabled;
  }

  async send(prompt: string, response: ChatResponseStream, signal: AbortSignal): Promise<ChatTurnResult> {
    const trace: ProviderTraceEntry[] = [];
    const startedAt = performance.now();
    let result: TurnResult | undefined;
    let failure: unknown;

    try {
      result = await this.provider.send(prompt, {
        signal,
        onText: value => response.push({ type: ChatResponsePartType.TEXT, value }),
        onReasoningSummary: value => response.push({ type: ChatResponsePartType.REASONING_SUMMARY, value }),
        onToolActivity: activity => response.push({ type: ChatResponsePartType.TOOL, activity }),
        onTrace: entry => { if (this.traceEnabled) trace.push(entry); },
      });
    } catch (error) {
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

    if (failure !== undefined) throw failure;
    if (!result) throw new ProviderError('Provider completed without a result.');
    this.recordUsage(result);
    return {
      ...result,
      durationMs: performance.now() - startedAt,
    };
  }
}
