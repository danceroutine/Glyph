import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { Tool } from '#src/tools/Tool.js';

export type TestToolHandler = (
  name: string,
  input: string,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
) => Promise<string>;
/** Test services must register the same capabilities their scripted provider calls. */
export function testToolSource(
  definitions: readonly Omit<Tool, 'validateInput' | 'execute'>[],
  execute: TestToolHandler,
): ToolSource & { execute: TestToolHandler } {
  return {
    execute,
    tools: definitions.map(definition => ({
      ...definition,
      validateInput: input => {
        JSON.parse(input);
      },
      execute: (input, signal, context) => execute(definition.name, input, signal, context),
    })),
  };
}
