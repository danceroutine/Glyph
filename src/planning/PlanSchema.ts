import { z } from 'zod';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
export const planContentSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(2000),
    markdown: z.string().min(1).max(100000),
    todos: z
      .array(
        z
          .object({ id: z.string().min(1).max(100), text: z.string().min(1).max(1000), completed: z.boolean() })
          .strict(),
      )
      .max(100)
      .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Todo IDs must be unique.')
      .describe(
        'The concrete, checkable steps that build this plan. Always provide them; a build tracks progress and finishes by checking off every todo.',
      ),
  })
  .strict();
export const planSchema = planContentSchema
  .extend({
    id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    agents: z
      .array(z.object({ chatId: z.string().min(1), role: z.enum(['Author', 'Builder', 'Reviewer']) }).strict())
      .max(100),
    build: z
      .object({ chatId: z.string().min(1), runId: z.string().min(1).max(100), startedAt: z.string().min(1) })
      .strict()
      .optional(),
  })
  .transform(({ build, ...plan }): GlyphPlanRecord => ({ ...plan, ...(build ? { build } : {}) }));
export const planUpdateSchema = planContentSchema
  .extend({
    id: z.string().min(1).max(100).nullable(),
    expectedRevision: z.number().int().positive().nullable(),
  })
  .refine(
    value => (value.id === null) === (value.expectedRevision === null),
    'An existing plan requires its expected revision.',
  );
export type PlanUpdate = z.infer<typeof planUpdateSchema>;
