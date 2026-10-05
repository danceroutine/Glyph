import type { ToolDefinition } from './ToolDefinition.ts';

/**
 * Provider-neutral tool registry and dispatcher. Provider adapters translate
 * definitions into their wire format and return calls here for execution.
 */
export interface ToolRuntime {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, input: string): Promise<string>;
}
