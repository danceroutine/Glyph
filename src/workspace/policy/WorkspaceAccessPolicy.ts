import { z } from 'zod';
import type { WorkspaceAccessPolicyOptions } from './WorkspaceAccessPolicyOptions.ts';

const defaults = {
  ignoredDirectories: ['.git', '.next', 'coverage', 'dist', 'node_modules', 'target'],
  sensitiveFileNames: ['.git-credentials', '.netrc', '.npmrc', '.pypirc'],
  sensitiveFilePrefixes: ['.env'],
  sensitiveFileExtensions: ['.key', '.pem', '.p12', '.pfx'],
  allowedFileNames: ['.env.example'],
} as const;

const schema = z
  .object({
    ignoredDirectories: z.array(z.string().min(1)).default([...defaults.ignoredDirectories]),
    sensitiveFileNames: z.array(z.string().min(1)).default([...defaults.sensitiveFileNames]),
    sensitiveFilePrefixes: z.array(z.string().min(1)).default([...defaults.sensitiveFilePrefixes]),
    sensitiveFileExtensions: z.array(z.string().regex(/^\.[^.]+$/u)).default([...defaults.sensitiveFileExtensions]),
    allowedFileNames: z.array(z.string().min(1)).default([...defaults.allowedFileNames]),
  })
  .strict();

/**
 * Canonical policy for paths that agents may discover or read. Project tools,
 * attachments, native search, and shell confinement must all receive the same
 * instance so a file cannot become accessible by switching capabilities.
 */
export class WorkspaceAccessPolicy {
  readonly ignoredDirectories: readonly string[];
  readonly sensitiveFileNames: readonly string[];
  readonly sensitiveFilePrefixes: readonly string[];
  readonly sensitiveFileExtensions: readonly string[];
  readonly allowedFileNames: readonly string[];

  constructor(options: WorkspaceAccessPolicyOptions = {}) {
    const resolved = schema.parse(options);
    this.ignoredDirectories = resolved.ignoredDirectories;
    this.sensitiveFileNames = resolved.sensitiveFileNames;
    this.sensitiveFilePrefixes = resolved.sensitiveFilePrefixes;
    this.sensitiveFileExtensions = resolved.sensitiveFileExtensions;
    this.allowedFileNames = resolved.allowedFileNames;
  }

  isSensitiveFileName(name: string): boolean {
    if (this.allowedFileNames.includes(name)) return false;
    return (
      this.sensitiveFileNames.includes(name) ||
      this.sensitiveFilePrefixes.some(prefix => name.startsWith(prefix)) ||
      this.sensitiveFileExtensions.some(extension => name.endsWith(extension))
    );
  }

  toJSON(): Required<WorkspaceAccessPolicyOptions> {
    return {
      ignoredDirectories: [...this.ignoredDirectories],
      sensitiveFileNames: [...this.sensitiveFileNames],
      sensitiveFilePrefixes: [...this.sensitiveFilePrefixes],
      sensitiveFileExtensions: [...this.sensitiveFileExtensions],
      allowedFileNames: [...this.allowedFileNames],
    };
  }
}
