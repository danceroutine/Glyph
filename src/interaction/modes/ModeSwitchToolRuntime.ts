import { AgentMode } from '#src/chat/AgentMode.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
const schema = z.object({ target: z.enum(AgentModeID), description: z.string().trim().min(1).max(4000) }).strict();
const { $schema: _, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' });
export class ModeSwitchToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: 'interaction',
      name: 'request_mode_switch',
      requiresExclusiveRound: true,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      inputKind: ToolInputKind.JSON,
      parameters,
      description: `Request permission to switch modes (${AgentMode.all.map(mode => mode.name).join(', ')}). Explain why in description. Call this tool alone in its round. A human or their configured countdown policy approves or denies; never assume approval.`,
      validateInput: input => {
        schema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute('request_mode_switch', input, signal, context),
    },
  ];

  constructor(
    private readonly request: (
      target: AgentModeID,
      description: string,
      context: ToolExecutionContext,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}
  async execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    if (name !== 'request_mode_switch' || !context?.chat || !context.onModeChanged || !signal)
      return JSON.stringify({ error: 'Mode changes require an active, owned chat run.' });
    const { target, description } = schema.parse(JSON.parse(input));
    if (target === context.mode)
      return JSON.stringify({ approved: false, mode: context.mode, message: 'Already in this mode.' });
    const approved = await this.request(target, description, context, signal);
    if (approved) context.onModeChanged(target);
    return JSON.stringify({
      approved,
      mode: approved ? target : context.mode,
      message: approved
        ? `Switched to ${target} mode. Follow its tool permissions for subsequent calls.`
        : 'The mode switch was denied. Continue in the current mode.',
    });
  }
}
