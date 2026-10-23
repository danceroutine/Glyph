import { z } from 'zod';
import { AgentReviewScope, AgentReviewStatus } from './AgentReview.ts';

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
    'Review paths must be workspace-relative.',
  );
export const agentReviewInputSchema = z
  .object({
    id: z.uuid(),
    repositoryUri: z.url().refine(value => value.startsWith('file:')),
    scope: z.enum(AgentReviewScope),
    branch: z.string().max(4096),
    label: z.string().min(1).max(4096),
    files: z
      .array(
        z
          .object({
            path,
            uri: z.url().refine(value => value.startsWith('file:')),
            before: z.string().max(2 * 1024 * 1024),
            after: z.string().max(2 * 1024 * 1024),
            contextText: z.string().max(2 * 1024 * 1024),
            revision: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.files.map(file => file.path)).size !== value.files.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate review paths.' });
    if (
      value.files.reduce((total, file) => total + Buffer.byteLength(file.before + file.after + file.contextText), 0) >
      6 * 1024 * 1024
    )
      ctx.addIssue({ code: 'custom', message: 'The captured review exceeds its size limit.' });
  });
export const agentReviewSchema = agentReviewInputSchema
  .safeExtend({
    accountProvider: z.string().min(1),
    accountId: z.string().min(1),
    model: z.string().min(1),
    status: z.enum(AgentReviewStatus),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1),
            path,
            line: z.number().int().positive(),
            side: z.enum(['original', 'modified']).optional(),
            title: z.string().min(1).max(300),
            body: z.string().min(1).max(8000),
          })
          .strict()
          .transform(({ side, ...finding }) => ({ ...finding, ...(side === undefined ? {} : { side }) })),
      )
      .max(100),
    dismissedIds: z.array(z.string()).max(100),
    summary: z.string().max(1024 * 1024),
    error: z.string().optional(),
  })
  .transform(({ error, ...review }) => ({ ...review, ...(error === undefined ? {} : { error }) }));
