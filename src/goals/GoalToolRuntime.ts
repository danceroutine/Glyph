import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { ChatGoal } from './ChatGoal.ts';
import { goalObjectiveSchema } from './GoalSchema.ts';
import { GoalStatus } from './GoalStatus.ts';
import { GoalToolName } from './GoalToolName.ts';
import { GoalToolNamespace } from './GoalToolNamespace.ts';
import { isEnumValue } from '#src/shared/validators/isEnumValue.js';

const createGoalSchema = z.object({ objective: goalObjectiveSchema }).strict();
const updateGoalSchema = z.object({ status: z.enum([GoalStatus.COMPLETE, GoalStatus.ACTIVE]) }).strict();
const { $schema: _create, ...createParameters } = z.toJSONSchema(createGoalSchema, { target: 'draft-7' });
const { $schema: _update, ...updateParameters } = z.toJSONSchema(updateGoalSchema, { target: 'draft-7' });

type GoalChat = NonNullable<ToolExecutionContext['chat']>;
export type GoalToolStatus = z.infer<typeof updateGoalSchema>['status'];

export class GoalToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: GoalToolNamespace.GOAL,
      name: GoalToolName.CREATE_GOAL,
      requiresExclusiveRound: true,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      description:
        'Propose a long-running goal for the current chat. Use this only when the human explicitly asks you to keep working toward an objective across turns; never for ordinary tasks. Restate the objective with every explicit deliverable and the evidence that will prove it. The human approves or declines the goal; never assume approval. Fails when the chat already has an active or paused goal. Call this tool alone in its round.',
      inputKind: ToolInputKind.JSON,
      parameters: createParameters,
      validateInput: input => {
        createGoalSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(GoalToolName.CREATE_GOAL, input, signal, context),
    },
    {
      namespace: GoalToolNamespace.GOAL,
      name: GoalToolName.UPDATE_GOAL,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      description:
        "Update the current chat's goal. Set status to complete only when current evidence proves the objective has been achieved and no required work remains, unless the human explicitly asks you to stop the goal. Never mark a goal complete merely because you are stopping work. You cannot pause a goal; the human controls that. Set status to active only when the human paused the goal and asks you to resume it.",
      inputKind: ToolInputKind.JSON,
      parameters: updateParameters,
      validateInput: input => {
        updateGoalSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(GoalToolName.UPDATE_GOAL, input, signal, context),
    },
  ];

  constructor(
    private readonly propose: (
      chat: GoalChat,
      objective: string,
      signal?: AbortSignal,
    ) => Promise<ChatGoal | undefined>,
    private readonly update: (chat: GoalChat, status: GoalToolStatus, signal?: AbortSignal) => Promise<ChatGoal>,
  ) {}

  async execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    if (!isEnumValue(GoalToolName, name)) throw new Error(`Unknown goal tool: ${name}`);
    try {
      signal?.throwIfAborted();
      if (!context?.chat) throw new Error('A host-owned chat is required to manage goals.');
      if (name === GoalToolName.CREATE_GOAL) {
        const { objective } = createGoalSchema.parse(JSON.parse(input));
        const goal = await this.propose(context.chat, objective, signal);
        return JSON.stringify(
          goal
            ? { approved: true, goal }
            : { approved: false, message: 'The human declined the goal. Continue with the current request.' },
        );
      }
      const { status } = updateGoalSchema.parse(JSON.parse(input));
      return JSON.stringify({ goal: await this.update(context.chat, status, signal) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return JSON.stringify({
        error: {
          code: error instanceof z.ZodError || error instanceof SyntaxError ? 'MALFORMED' : 'GOAL_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Could not update the goal.',
        },
      });
    }
  }
}
