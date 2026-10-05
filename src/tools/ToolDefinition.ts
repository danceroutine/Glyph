import type { ToolInputKind } from './ToolInputKind.ts';

/** Provider-neutral description of a model-callable capability. */
export interface ToolDefinition {
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly inputKind: ToolInputKind;
  readonly parameters?: Record<string, unknown>;
}
