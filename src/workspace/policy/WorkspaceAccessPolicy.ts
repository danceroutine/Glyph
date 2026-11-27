import { posix, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { WorkspaceAccessPolicyOptions } from './WorkspaceAccessPolicyOptions.ts';

const skillStagingDirectory = '.skill-staging';
function isStagingDirectory(component: string, caseSensitive: boolean): boolean {
  return caseSensitive ? component === skillStagingDirectory : /^\.skill-(?:st|ﬅ|ﬆ)aging$/iu.test(component);
}

const defaults = {
  ignoredDirectories: ['.artifacts', '.code-oss', '.git', '.next', 'coverage', 'dist', 'node_modules', 'target'],
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

  private privatePathSnapshot: readonly string[] = [];
  private privatePathRevision = 0;

  constructor(
    options: WorkspaceAccessPolicyOptions = {},
    private readonly privatePathSource: readonly string[] | (() => readonly string[]) = [],
  ) {
    const resolved = schema.parse(options);
    // Transaction journals, locks and rollback copies remain host-private under customized policies too.
    this.ignoredDirectories = [...new Set([...resolved.ignoredDirectories, skillStagingDirectory])];
    this.sensitiveFileNames = resolved.sensitiveFileNames;
    this.sensitiveFilePrefixes = resolved.sensitiveFilePrefixes;
    this.sensitiveFileExtensions = resolved.sensitiveFileExtensions;
    this.allowedFileNames = resolved.allowedFileNames;
  }

  /** Absolute host exclusions, including profiles admitted after this policy was constructed. */
  get privatePaths(): readonly string[] {
    const paths = typeof this.privatePathSource === 'function' ? this.privatePathSource() : this.privatePathSource;
    if (
      paths.length !== this.privatePathSnapshot.length ||
      paths.some((path, i) => path !== this.privatePathSnapshot[i])
    ) {
      this.privatePathSnapshot = Object.freeze([...paths]);
      this.privatePathRevision++;
    }
    return this.privatePathSnapshot;
  }

  /** Monotonic generation used to reject results produced under an older host boundary. */
  get revision(): number {
    void this.privatePaths;
    return this.privatePathRevision;
  }

  /** Project absolute host exclusions into the namespace of a single attached filesystem root. */
  exclusionsFor(root: string, caseSensitive: boolean): { privateRoot: boolean; excludedPaths: string[] } {
    const key = (path: string): string => {
      const normalized = resolve(path).split(sep).join('/');
      return caseSensitive ? normalized : normalized.toLowerCase();
    };
    const rootKey = key(root);
    let privateRoot = rootKey.split('/').some(part => isStagingDirectory(part, caseSensitive));
    const excludedPaths: string[] = [];
    for (const path of this.privatePaths) {
      const pathKey = key(path);
      const relative = posix.relative(rootKey, pathKey);
      if (relative === '' || rootKey.startsWith(pathKey.endsWith('/') ? pathKey : pathKey + '/')) privateRoot = true;
      else if (relative !== '..' && !relative.startsWith('../')) {
        // The suffix can cross a mount whose casing differs from the attached root.
        excludedPaths.push(resolve(path).split(sep).slice(-relative.split('/').length).join('/'));
      }
    }
    return { privateRoot, excludedPaths };
  }

  isIgnoredDirectory(name: string, caseSensitive: boolean): boolean {
    if (isStagingDirectory(name, caseSensitive)) return true;
    return this.ignoredDirectories.some(value =>
      caseSensitive ? value === name : value.toLowerCase() === name.toLowerCase(),
    );
  }

  isSensitiveFileName(name: string, caseSensitive = true): boolean {
    const normalize = (value: string): string => (caseSensitive ? value : value.toLowerCase());
    name = normalize(name);
    if (this.allowedFileNames.some(value => normalize(value) === name)) return false;
    return (
      this.sensitiveFileNames.some(value => normalize(value) === name) ||
      this.sensitiveFilePrefixes.some(prefix => name.startsWith(normalize(prefix))) ||
      this.sensitiveFileExtensions.some(extension => name.endsWith(normalize(extension)))
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
