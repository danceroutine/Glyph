import { z } from 'zod';

const defaults = {
  ignoredDirectories: ['.git', '.next', 'coverage', 'dist', 'node_modules', 'target'],
  excludedPaths: [],
  sensitiveFileNames: ['.netrc', '.npmrc', '.pypirc'],
  sensitiveFilePrefixes: ['.env'],
  sensitiveFileExtensions: ['.key', '.pem', '.p12', '.pfx'],
  allowedFileNames: ['.env.example'],
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
    ignoredDirectories: z.array(z.string().min(1)).default([...defaults.ignoredDirectories]),
    excludedPaths: z.array(z.string().min(1)).default([...defaults.excludedPaths]),
    sensitiveFileNames: z.array(z.string().min(1)).default([...defaults.sensitiveFileNames]),
    sensitiveFilePrefixes: z.array(z.string().min(1)).default([...defaults.sensitiveFilePrefixes]),
    sensitiveFileExtensions: z.array(z.string().min(1)).default([...defaults.sensitiveFileExtensions]),
    allowedFileNames: z.array(z.string().min(1)).default([...defaults.allowedFileNames]),
    respectGitIgnore: z.boolean().default(defaults.respectGitIgnore),
    maxFiles: z.number().int().positive().max(4_294_967_295).default(defaults.maxFiles),
    maxContentSearchFileBytes: z.number().int().positive().default(defaults.maxContentSearchFileBytes),
    caseSensitive: z.boolean().default(defaults.caseSensitive),
  })
  .strict();

export type RustWorkspacePathIndexOptions = z.input<typeof rustWorkspacePathIndexOptionsSchema>;

export type ResolvedRustWorkspacePathIndexOptions = z.output<typeof rustWorkspacePathIndexOptionsSchema>;
