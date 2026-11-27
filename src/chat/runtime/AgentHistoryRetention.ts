import { isRecord } from '#src/shared/validators/isRecord.js';
import type { TurnContextEnvelope } from '#src/context/turns/TurnContextEnvelope.js';
import type { AgentHistoryProjection } from './AgentHistoryProjection.ts';

/**
 * Project host instruction envelopes in protocol-independent user and tool content.
 * Durable history drops them. A live turn can retain the portions still authorized for replay. Ordinary user and tool data,
 * including nested file content with similarly named fields, remain unchanged.
 */
export class AgentHistoryRetention implements AgentHistoryProjection {
  constructor(private readonly retainEnvelope?: (context: TurnContextEnvelope) => TurnContextEnvelope | undefined) {}

  userMessage(content: string): string | undefined {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return content;
    }
    return isInstructionEnvelope(value) ? JSON.stringify(this.retainEnvelope?.(value)) : content;
  }

  toolOutput(output: string): string {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      return output;
    }
    if (!isRecord(value) || !isInstructionEnvelope(value.instructionContext)) return output;
    return JSON.stringify({ ...value, instructionContext: this.retainEnvelope?.(value.instructionContext) });
  }
}

function isInstructionEnvelope(value: unknown): value is TurnContextEnvelope {
  return isRecord(value) && value.schema === 'glyph.agent-instructions.v1' && Array.isArray(value.sources);
}
