import { z } from 'zod';

export const workspaceContentSearchOptionsSchema = z
  .object({
    patternKind: z.enum(['regular_expression', 'literal']).default('regular_expression'),
    path: z.string().min(1).nullable().default(null),
    fileGlob: z.string().min(1).max(4_096).nullable().default(null),
    fileType: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .default(null),
    outputMode: z.enum(['content', 'files_with_matches', 'count']).default('content'),
    linesBefore: z.number().int().min(0).max(20).default(0),
    linesAfter: z.number().int().min(0).max(20).default(0),
    caseSensitive: z.boolean().default(true),
    multiline: z.boolean().default(false),
    limit: z.number().int().min(1).max(1_000).default(100),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

/** Serializable content-search inputs plus host-local cancellation. */
export type WorkspaceContentSearchOptions = z.input<typeof workspaceContentSearchOptionsSchema> & {
  readonly signal?: AbortSignal | undefined;
};
