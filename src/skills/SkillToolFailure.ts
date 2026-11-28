import { ToolOperationError } from '#src/tools/ToolOperationError.js';
/** Preserve actionable domain failures while keeping uncertain mutations explicit to the model. */
export function skillToolFailure(error: unknown, outcome: 'not_started' | 'unknown'): ToolOperationError {
  if (error instanceof ToolOperationError) return error;
  return new ToolOperationError(
    'SKILL_OPERATION_FAILED',
    error instanceof Error ? error.message : 'Skill operation failed.',
    outcome,
  );
}
