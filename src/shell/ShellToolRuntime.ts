import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import type { ShellSessionManager } from './ShellSessionManager.ts';
import { ShellToolName } from './ShellToolName.ts';
import { ShellToolNamespace } from './ShellToolNamespace.ts';

const executeArgumentsSchema = z
  .object({
    command: z.string().min(1).describe('Shell command to execute after human authorization.'),
    terminal_id: z.string().min(1).nullable().describe('Existing terminal identifier, or null to create one.'),
    working_directory: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Project-relative starting directory for a new terminal, or null for a folder project root. In a multi-root workspace, begin with the root name.',
      ),
    background: z.boolean().describe('Return immediately and keep the terminal alive.'),
    wake_on: z
      .string()
      .min(1)
      .nullable()
      .describe('One-shot literal output text that should awaken the agent, or null.'),
    timeout_ms: z.number().int().positive().max(600_000).nullable(),
  })
  .strict();
const writeInputArgumentsSchema = z
  .object({
    terminal_id: z.string().min(1),
    input: z.string(),
    append_newline: z.boolean(),
    wake_on: z.string().min(1).nullable(),
  })
  .strict();
const closeArgumentsSchema = z.object({ terminal_id: z.string().min(1) }).strict();
const listArgumentsSchema = z.object({}).strict();

/** Provider-neutral lifecycle tools for authorized project shell sessions. */
export class ShellToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: ShellToolNamespace.SHELL,
      name: ShellToolName.EXECUTE,
      allowedModes: [AgentModeID.AGENT],
      description:
        'Execute an authorized command in a project shell. Set background true for long-running work and optionally provide wake_on literal output. Reuse an idle terminal_id for a subsequent command.',
      inputKind: ToolInputKind.JSON,
      parameters: jsonSchema(executeArgumentsSchema),
      validateInput: input => {
        executeArgumentsSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(ShellToolName.EXECUTE, input, signal, context),
    },
    {
      namespace: ShellToolNamespace.SHELL,
      name: ShellToolName.WRITE_INPUT,
      allowedModes: [AgentModeID.AGENT],
      description:
        'Write interactive input to a running background shell command and optionally replace its one-shot wake_on condition. This cannot start a new command; use execute_shell so each new command is authorized.',
      inputKind: ToolInputKind.JSON,
      parameters: jsonSchema(writeInputArgumentsSchema),
      validateInput: input => {
        writeInputArgumentsSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(ShellToolName.WRITE_INPUT, input, signal, context),
    },
    {
      namespace: ShellToolNamespace.SHELL,
      name: ShellToolName.CLOSE,
      allowedModes: [AgentModeID.AGENT],
      description: 'Terminate and remove a background shell terminal.',
      inputKind: ToolInputKind.JSON,
      parameters: jsonSchema(closeArgumentsSchema),
      validateInput: input => {
        closeArgumentsSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(ShellToolName.CLOSE, input, signal, context),
    },
    {
      namespace: ShellToolNamespace.SHELL,
      name: ShellToolName.LIST,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      description: 'List live background shell terminals, their status, commands, and recent output.',
      inputKind: ToolInputKind.JSON,
      parameters: jsonSchema(listArgumentsSchema),
      validateInput: input => {
        listArgumentsSchema.parse(JSON.parse(input));
      },
      execute: (input, signal, context) => this.execute(ShellToolName.LIST, input, signal, context),
    },
  ];

  constructor(private readonly sessions: ShellSessionManager) {}

  async execute(
    name: string,
    input: string,
    signal = new AbortController().signal,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const ownerChatId = context?.chat?.id;
      if (!ownerChatId) throw new Error('Shell tools require an owning chat execution context.');
      switch (name) {
        case ShellToolName.EXECUTE: {
          const {
            command,
            terminal_id: terminalId,
            working_directory: workingDirectory,
            background,
            wake_on: wakeOn,
            timeout_ms: timeoutMs,
          } = executeArgumentsSchema.parse(JSON.parse(input));
          const result = await this.sessions.execute(command, {
            ...(context?.executionId ? { executionId: context.executionId } : {}),
            ...(terminalId === null ? {} : { terminalId }),
            ...(workingDirectory === null ? {} : { workingDirectory }),
            background,
            ...(wakeOn === null ? {} : { wakeOn }),
            ...(timeoutMs === null ? {} : { timeoutMs }),
            signal,
            ownerChatId,
          });
          return JSON.stringify(serializeCommandResult(result));
        }
        case ShellToolName.WRITE_INPUT: {
          const {
            terminal_id: terminalId,
            input: value,
            append_newline: appendNewline,
            wake_on: wakeOn,
          } = writeInputArgumentsSchema.parse(JSON.parse(input));
          await this.sessions.writeInput({
            terminalId,
            input: value,
            appendNewline,
            ...(wakeOn === null ? {} : { wakeOn }),
            ownerChatId,
            signal,
          });
          return JSON.stringify({ terminal_id: terminalId, status: 'input_written' });
        }
        case ShellToolName.CLOSE: {
          const { terminal_id: terminalId } = closeArgumentsSchema.parse(JSON.parse(input));
          await this.sessions.close(terminalId, ownerChatId);
          return JSON.stringify({ terminal_id: terminalId, status: 'closed' });
        }
        case ShellToolName.LIST:
          listArgumentsSchema.parse(JSON.parse(input));
          return JSON.stringify({
            terminals: this.sessions.sessionsFor(ownerChatId).map(session => ({
              terminal_id: session.id,
              ...(session.ownerChatId ? { owner_chat_id: session.ownerChatId } : {}),
              working_directory: session.workingDirectory,
              command: session.command,
              status: session.status,
              output_tail: session.outputTail,
              started_at: session.startedAt,
              ...(session.exitCode === undefined ? {} : { exit_code: session.exitCode }),
              ...(session.wakePattern === undefined ? {} : { wake_on: session.wakePattern }),
            })),
          });
        default:
          throw new Error(`Unknown shell tool: ${name}`);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return JSON.stringify({
        error: {
          code: error instanceof z.ZodError || error instanceof SyntaxError ? 'MALFORMED' : 'SHELL_FAILED',
          message: error instanceof Error ? error.message : 'Shell operation failed.',
        },
      });
    }
  }
}

function serializeCommandResult(result: Awaited<ReturnType<ShellSessionManager['execute']>>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    terminal_id: result.terminalId,
    ...(result.workingDirectory ? { working_directory: result.workingDirectory } : {}),
    status: result.status,
    output: result.output,
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
  };
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    serialized.error = {
      code: 'COMMAND_EXITED',
      message: `Shell command exited with code ${result.exitCode}.`,
    };
  }
  return serialized;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' });
  return parameters;
}
