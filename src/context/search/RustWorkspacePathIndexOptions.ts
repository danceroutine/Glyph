import { z } from 'zod';
import type { WorkspaceAccessPolicy } from '../../workspace/policy/WorkspaceAccessPolicy.ts';

const defaults = {
  excludedPaths: [],
  respectGitIgnore: true,
  maxFiles: 2_000_000,
  maxContentSearchFileBytes: 8 * 1_024 * 1_024,
  caseSensitive: process.platform !== 'darwin' && process.platform !== 'win32',
} as const;

/**
 * Initialization options understood by the version-one Rust index protocol.
 * Defaults live on the TypeScript boundary so every native request carries one
 * complete, validated configuration instead of relying on scattered omission
 * semantics in both processes.
 */
export const rustWorkspacePathIndexOptionsSchema = z
  .object({
    binaryPath: z.string().min(1),
    root: z.string().min(1),
    cachePath: z.string().min(1).nullable().default(null),
    excludedPaths: z.array(z.string().min(1)).default([...defaults.excludedPaths]),
    respectGitIgnore: z.boolean().default(defaults.respectGitIgnore),
    maxFiles: z.number().int().positive().max(4_294_967_295).default(defaults.maxFiles),
    maxContentSearchFileBytes: z.number().int().positive().default(defaults.maxContentSearchFileBytes),
    caseSensitive: z.boolean().default(defaults.caseSensitive),
  })
  .strict();

export type RustWorkspacePathIndexOptions = z.input<typeof rustWorkspacePathIndexOptionsSchema>;

export type RustWorkspacePathIndexConfiguration = RustWorkspacePathIndexOptions & {
  readonly accessPolicy?: WorkspaceAccessPolicy;
};

export type ResolvedRustWorkspacePathIndexOptions = z.output<typeof rustWorkspacePathIndexOptionsSchema> &
  ReturnType<WorkspaceAccessPolicy['toJSON']>;
