import { z } from 'zod';

/** Bounded display data saved with a tool activity, separate from resumable process state. */
export const shellCommandSummarySchema = z
  .object({
    command: z.string(),
    output: z.string(),
    workingDirectory: z.string().optional(),
    sessionId: z.string().optional(),
    exitCode: z.number().optional(),
    error: z.string().optional(),
    background: z.boolean(),
  })
  .transform(({ workingDirectory, sessionId, exitCode, error, ...value }) => ({
    ...value,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(error === undefined ? {} : { error }),
  }));
export type ShellCommandSummary = z.infer<typeof shellCommandSummarySchema>;
