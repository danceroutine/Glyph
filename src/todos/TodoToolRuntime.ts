import { z } from 'zod';
import type { ToolRuntime } from '#src/tools/ToolRuntime.js';
import type { ToolDefinition } from '#src/tools/ToolDefinition.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { TodoItem } from './TodoItem.ts';
import { todoUpdateSchema, type TodoUpdate } from './TodoUpdate.ts';
import { TodoToolName } from './TodoToolName.ts';
import { TodoToolNamespace } from './TodoToolNamespace.ts';

const { $schema: _, ...parameters } = z.toJSONSchema(todoUpdateSchema, { target: 'draft-7' });

/** Updates only the host-supplied chat; successful results describe durable state. */
export class TodoToolRuntime implements ToolRuntime {
  readonly definitions: readonly ToolDefinition[] = [
    {
      namespace: TodoToolNamespace.TODO,
      name: TodoToolName.UPDATE_TODOS,
      description:
        'Maintain a concise action list for multi-step work in the current chat. Use stable IDs to update items without duplicating them. Mark work completed only after it is done; ending a turn does not complete unfinished work. The human sees this list read-only. Use replace only to deliberately start a new list or clear it.',
      inputKind: ToolInputKind.JSON,
      parameters,
    },
  ];

  constructor(
    private readonly update: (
      chat: NonNullable<ToolExecutionContext['chat']>,
      update: TodoUpdate,
      signal?: AbortSignal,
    ) => Promise<readonly TodoItem[]>,
  ) {}

  async execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    if (name !== TodoToolName.UPDATE_TODOS) throw new Error(`Unknown todo tool: ${name}`);
    try {
      signal?.throwIfAborted();
      if (!context?.chat) throw new Error('A host-owned chat is required to update todos.');
      const update = todoUpdateSchema.parse(JSON.parse(input));
      const items = await this.update(context.chat, update, signal);
      return JSON.stringify({ items });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return JSON.stringify({
        error: {
          code: error instanceof z.ZodError || error instanceof SyntaxError ? 'MALFORMED' : 'TODO_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Could not update todos.',
        },
      });
    }
  }
}
