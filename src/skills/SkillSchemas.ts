import { z } from 'zod';
import type { SkillDescriptor, SkillActivation } from './SkillDescriptor.ts';

/** Durable descriptor validation is shared by catalog persistence and turn provenance. */
export const skillDescriptorSchema: z.ZodType<SkillDescriptor> = z
  .object({
    id: z.string(),
    origin: z
      .object({ id: z.string(), label: z.string(), scope: z.enum(['user', 'project']), compatibility: z.string() })
      .strict(),
    path: z.string(),
    directory: z.string(),
    scope: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    status: z.enum(['active', 'error', 'discovery-error']),
    revision: z.string().optional(),
    compatibility: z.string().optional(),
    installedFrom: z.string().optional(),
    packageRevision: z.string().optional(),
    allowedTools: z.array(z.string()),
    uri: z.string(),
    message: z.string().optional(),
  })
  .strict()
  .transform(({ revision, compatibility, message, installedFrom, packageRevision, ...descriptor }) => ({
    ...descriptor,
    ...(revision !== undefined ? { revision } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(installedFrom !== undefined ? { installedFrom } : {}),
    ...(packageRevision !== undefined ? { packageRevision } : {}),
  }));

/** Retain the exact activated body and accessed resources; discovery descriptors alone cannot reconstruct history. */
export const skillActivationSchema: z.ZodType<SkillActivation> = z
  .object({
    descriptor: skillDescriptorSchema,
    revision: z.string(),
    reason: z.enum(['manual', 'model']),
    explanation: z.string(),
    body: z.string(),
    resources: z.array(
      z
        .object({ path: z.string(), revision: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']) })
        .strict(),
    ),
  })
  .strict();
