import { z } from 'zod';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import type { Tool } from '#src/tools/Tool.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';

const activateRuleSchema = z.object({ id: z.string().trim().min(1).max(1024) }).strict();
const { $schema: _, ...parameters } = z.toJSONSchema(activateRuleSchema, { target: 'draft-7' });

/** Supplies the body of a model-selectable rule only after the model chooses its bounded catalog entry. */
export class RuleToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: 'context',
      name: 'activate_rule',
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      inputKind: ToolInputKind.JSON,
      parameters,
      description:
        'Activate one relevant rule from the rule catalog supplied with this turn. Pass its exact stable id. The result contains the full rule instructions once; do not call it for rules absent from the catalog.',
      validateInput: input => {
        activateRuleSchema.parse(JSON.parse(input));
      },
      execute: (input, _signal, context) => {
        if (!context.turnId)
          return Promise.resolve(JSON.stringify({ error: 'Rule activation requires an active turn.' }));
        const { id } = activateRuleSchema.parse(JSON.parse(input));
        const instructionContext = this.turns.activateRule(context.turnId, id);
        return Promise.resolve(
          JSON.stringify(
            instructionContext
              ? { activated: true, instructionContext }
              : { activated: false, message: 'The rule is unavailable, ineligible, or already active.' },
          ),
        );
      },
    },
  ];

  constructor(private readonly turns: Pick<TurnContextCoordinator, 'activateRule'>) {}
}
