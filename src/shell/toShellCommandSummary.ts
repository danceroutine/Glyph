import { z } from 'zod';
import type { ToolActivity } from '#src/chat/ToolActivity.js';
import type { ShellCommandSummary } from './ShellCommandSummary.ts';
import { ShellToolName } from './ShellToolName.ts';

const argumentsSchema = z.object({
  command: z.string().optional(),
  working_directory: z.string().nullable().optional(),
  terminal_id: z.string().nullable().optional(),
  background: z.boolean().optional(),
});
const terminalSchema = z.object({
  terminal_id: z.string(),
  command: z.string(),
  working_directory: z.string(),
  status: z.string(),
  output_tail: z.string(),
  exit_code: z.number().optional(),
});
const resultSchema = z.object({
  terminal_id: z.string().optional(),
  working_directory: z.string().optional(),
  output: z.string().optional(),
  exit_code: z.number().optional(),
  error: z.object({ message: z.string() }).optional(),
  terminals: z.array(terminalSchema).optional(),
});
const labels: Record<ShellToolName, string> = {
  [ShellToolName.EXECUTE]: 'Shell command',
  [ShellToolName.WRITE_INPUT]: 'Write shell input',
  [ShellToolName.CLOSE]: 'Close shell',
  [ShellToolName.LIST]: 'List shells',
};

/** Parse at the host boundary; the renderer receives display fields, never tool JSON. */
export function toShellCommandSummary(activity: ToolActivity): ShellCommandSummary | undefined {
  const name = z.enum(ShellToolName).safeParse(activity.name);
  if (activity.namespace !== 'shell' || !name.success) return undefined;
  try {
    const input = argumentsSchema.parse(JSON.parse(activity.arguments));
    const result = activity.output ? resultSchema.parse(JSON.parse(activity.output)) : undefined;
    const sessionId = result?.terminal_id ?? input.terminal_id;
    const workingDirectory = result?.working_directory ?? input.working_directory;
    const output = result?.terminals
      ? result.terminals.length
        ? result.terminals
            .map(
              session =>
                `${session.terminal_id} · ${session.status}${session.exit_code === undefined ? '' : ` · Exit ${session.exit_code}`}\n${session.command}\n${session.working_directory}\n${session.output_tail.slice(-2048)}`,
            )
            .join('\n\n')
        : 'No shell sessions.'
      : (result?.output ?? '');
    return {
      command: input.command ?? labels[name.data],
      output: result?.terminals ? output : output.slice(-64 * 1024),
      background: input.background ?? false,
      ...(sessionId ? { sessionId } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(result?.exit_code === undefined ? {} : { exitCode: result.exit_code }),
      ...(result?.error ? { error: result.error.message.slice(0, 4096) } : {}),
    };
  } catch {
    return undefined;
  }
}
