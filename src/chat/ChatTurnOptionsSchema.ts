import { AgentModeID } from "./AgentMode.ts";
import { z } from 'zod';
export const annotationSchema = z
  .object({
    id: z.string().min(1).max(100),
    order: z.number().int().positive(),
    kind: z.enum(['chat', 'plan', 'proposal']),
    sourceId: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
    label: z.string().max(1000),
    quote: z.string().min(1).max(50000),
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    comment: z.string().trim().min(1).max(10000),
  })
  .strict()
  .refine(
    value => value.to > value.from && value.to - value.from === value.quote.length,
    'The quote must match the captured range.',
  );
export const chatTurnOptionsSchema = z
  .object({
    attachmentSpans: z
      .array(
        z
          .object({ from: z.number().int().nonnegative(), to: z.number().int().positive() })
          .strict()
          .refine(span => span.to > span.from),
      )
      .max(32)
      .optional(),
    turnId: z.string().min(1).max(100).optional(),
    mode: z.enum(AgentModeID).optional(),
    annotations: z.array(annotationSchema).max(100).optional(),
  })
  .strict()
  .transform(({ mode, annotations, turnId, attachmentSpans }) => ({
    ...(attachmentSpans ? { attachmentSpans } : {}),
    ...(turnId ? { turnId } : {}),
    ...(mode ? { mode } : {}),
    ...(annotations ? { annotations } : {}),
  }));
