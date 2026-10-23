import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import { planUpdateSchema, type PlanUpdate } from './PlanSchema.ts';
import { PlanError } from './PlanError.ts';
const { $schema: _, ...parameters } = z.toJSONSchema(planUpdateSchema, { target: 'draft-7' });
export class PlanToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: 'planning',
      name: 'save_plan',
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      inputKind: ToolInputKind.JSON,
      parameters,
      description:
        'Save a plan for human review. Include Markdown, a short summary and todos. Always include todos: break the work into concrete, independently checkable steps with short stable IDs, in the order they should be done. A plan without todos is almost always incomplete, because building a plan seeds the builder’s todo list from these todos and the build only finishes once every one is checked off. For a new plan pass null id and expectedRevision; to revise use its returned id and revision. This does not execute work or authorize leaving Plan Mode.',
      validateInput: input => {
        planUpdateSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute('save_plan', input, signal, context),
    },
  ];

  constructor(
    private readonly save: (
      chat: NonNullable<ToolExecutionContext['chat']>,
      update: PlanUpdate,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  async execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    try {
      signal?.throwIfAborted();
      if (name !== 'save_plan' || !context?.chat) throw new PlanError('Saving a plan requires its owning chat.');
      return JSON.stringify(await this.save(context.chat, planUpdateSchema.parse(JSON.parse(input)), signal));
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return JSON.stringify({
        error: { code: 'PLAN_SAVE_FAILED', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
