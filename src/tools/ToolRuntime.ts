import type { ToolDefinition } from './ToolDefinition.ts';

export interface ToolRuntime {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, input: string): Promise<string>;
}
