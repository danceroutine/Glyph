import { AgentModeID } from './AgentMode.ts';
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
export const planBuildOrderSchema = z
  .object({
    planId: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    title: z.string().max(500),
    sourceChatId: z.string().min(1).max(100),
    todos: z
      .array(
        z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(1000), completed: z.boolean() }).strict(),
      )
      .max(100),
  })
  .strict();
export const planProgressSchema = z
  .object({
    planId: z.string().min(1).max(100),
    title: z.string().max(500),
    current: z.string().min(1).max(1000).optional(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .refine(value => value.completed <= value.total, 'Completed todos cannot exceed the total.')
  .transform(({ current, ...progress }) => ({ ...progress, ...(current ? { current } : {}) }));
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
    agentReviewId: z.string().uuid().optional(),
    mode: z.enum(AgentModeID).optional(),
    annotations: z.array(annotationSchema).max(100).optional(),
    planBuild: planBuildOrderSchema.optional(),
    planProgress: planProgressSchema.optional(),
  })
  .strict()
  .transform(({ mode, annotations, turnId, attachmentSpans, agentReviewId, planBuild, planProgress }) => ({
    ...(attachmentSpans ? { attachmentSpans } : {}),
    ...(turnId ? { turnId } : {}),
    ...(agentReviewId ? { agentReviewId } : {}),
    ...(mode ? { mode } : {}),
    ...(annotations ? { annotations } : {}),
    ...(planBuild ? { planBuild } : {}),
    ...(planProgress ? { planProgress } : {}),
  }));
