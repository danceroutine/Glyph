import { isRecord } from '#src/shared/validators/isRecord.js';
import type { AgentHistoryProjection } from './AgentHistoryProjection.ts';

/**
 * Host policy for durable conversation history, independent of provider wire formats.
 * Instruction envelopes belong to the current turn. Ordinary user and tool data,
 * including nested file content with similarly named fields, remain unchanged.
 */
export class AgentHistoryRetention implements AgentHistoryProjection {
  userMessage(content: string): string | undefined {
    try {
      return isInstructionEnvelope(JSON.parse(content)) ? undefined : content;
    } catch {
      return content;
    }
  }

  toolOutput(output: string): string {
    try {
      const value: unknown = JSON.parse(output);
      if (!isRecord(value) || !isInstructionEnvelope(value.instructionContext)) return output;
      delete value.instructionContext;
      return JSON.stringify(value);
    } catch {
      return output;
    }
  }
}

function isInstructionEnvelope(value: unknown): boolean {
  return isRecord(value) && value.schema === 'glyph.agent-instructions.v1' && Array.isArray(value.sources);
}
