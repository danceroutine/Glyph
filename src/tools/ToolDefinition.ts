import type { ToolInputKind } from './ToolInputKind.ts';

export interface ToolDefinition {
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly inputKind: ToolInputKind;
  readonly parameters?: Record<string, unknown>;
}
