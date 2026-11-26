import { skillToolFailure } from './SkillToolFailure.ts';
import { z } from 'zod';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { Tool } from '#src/tools/Tool.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { SkillTurnContext } from './SkillContextContributor.ts';

const activationSchema = z
  .object({ id: z.string().min(1).max(500), reason: z.string().trim().min(1).max(1000) })
  .strict();
const resourceSchema = z.object({ id: z.string().min(1).max(500), path: z.string().min(1).max(1000) }).strict();

/** Skill activation and resource reads share turn authority and never execute package content. */
export class SkillToolRuntime implements ToolSource {
  readonly tools: readonly Tool[];
  constructor(turns: Pick<TurnContextCoordinator, 'activateSource' | 'contribution'>) {
    this.tools = [
      {
        namespace: 'skills',
        name: 'activate',
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        inputKind: ToolInputKind.JSON,
        description:
          'Load one relevant skill from the advertised metadata catalog. Copy its stable ID and explain why it applies. Activation loads instructions, not resources, and grants no permissions.',
        parameters: parameters(activationSchema),
        validateInput: input => {
          activationSchema.parse(JSON.parse(input));
        },
        execute: async (input, signal, context) => {
          if (!context.turnId) throw new Error('Skill activation requires an active turn.');
          const selected = activationSchema.parse(JSON.parse(input));
          const instructionContext = await turns.activateSource(
            context.turnId,
            'skills',
            selected.id,
            'model',
            selected.reason,
            signal,
          );
          return JSON.stringify(
            instructionContext
              ? { activated: true, instructionContext }
              : { activated: false, message: 'Skill is unavailable, unadvertised, or already active.' },
          );
        },
      },
      {
        namespace: 'skills',
        name: 'read_resource',
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        inputKind: ToolInputKind.JSON,
        description:
          'Read one resource relative to an activated skill package. References, scripts, and templates are returned as content; this tool never executes scripts. Paths cannot escape the package.',
        parameters: parameters(resourceSchema),
        validateInput: input => {
          resourceSchema.parse(JSON.parse(input));
        },
        execute: async (input, signal, context) => {
          signal.throwIfAborted();
          if (!context.turnId) throw new Error('Skill resources require an active turn.');
          const selected = resourceSchema.parse(JSON.parse(input));
          const session = turns.contribution(context.turnId, 'skills');
          if (!(session instanceof SkillTurnContext)) throw new Error('Skill context is unavailable.');
          const resource = session.readResource(selected.id, selected.path);
          return JSON.stringify({
            read: true,
            instructionContext: {
              schema: 'glyph.agent-instructions.v1',
              sources: [],
              skillResources: [{ skillId: selected.id, ...resource }],
            },
          });
        },
      },
    ];
    this.tools = this.tools.map(tool => ({
      ...tool,
      execute: async (input, signal, context) => {
        try {
          return await tool.execute(input, signal, context);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw skillToolFailure(error, 'not_started');
        }
      },
    }));
  }
}

function parameters(schema: typeof activationSchema | typeof resourceSchema) {
  const { $schema: _, ...parameters_ } = z.toJSONSchema(schema, { target: 'draft-7' });
  return parameters_;
}
