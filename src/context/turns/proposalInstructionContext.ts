import { z } from 'zod';
import type { TurnContextEnvelope } from './TurnContextEnvelope.ts';

const required = 'INSTRUCTION_CONTEXT_REQUIRED';

/** Resubmit a proposal after the model has seen newly applicable repository guidance. */
export function proposalInstructionContext(instructionContext: TurnContextEnvelope): string {
  return JSON.stringify({
    status: required,
    instructionContext,
    message: 'Scoped repository instructions apply to this change. Regenerate the proposal with them and retry.',
  });
}

export const proposalActivityPresentation = {
  afterCompletion: true as const,
  show(output: string): boolean {
    const reply: unknown = JSON.parse(output);
    return z.object({ status: z.string().optional() }).parse(reply).status !== required;
  },
};
