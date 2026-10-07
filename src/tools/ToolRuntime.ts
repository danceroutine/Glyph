import type { ToolDefinition } from './ToolDefinition.ts';
import type { ToolExecutionContext } from './ToolExecutionContext.ts';

/**
 * Provider-neutral tool registry and dispatcher. Provider adapters translate
 * definitions into their wire format and return calls here for execution.
 */
export interface ToolRuntime {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string>;
}
