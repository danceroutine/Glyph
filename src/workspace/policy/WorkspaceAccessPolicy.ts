import { lstatSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { normalizeVolumeName } from '../FilesystemNamePolicy.ts';
import { workspaceCaseSensitivity } from '../workspaceCaseSensitivity.ts';
import { z } from 'zod';
import type { WorkspaceAccessPolicyOptions } from './WorkspaceAccessPolicyOptions.ts';

export const skillExecutionDirectory = '.glyph-skill-run';
const privateDirectories = ['.skill-staging', skillExecutionDirectory];

function isPrivateDirectory(name: string, caseSensitive: boolean, path?: string, physicalGuard = false): boolean {
  if (privateDirectories.includes(name)) return true;
  // Only possible aliases require a filesystem lookup. Ordinary components stay on the fast path.
  if (!name.startsWith('.')) return false;
  const reserved = normalizeVolumeName(name, { normalizesUnicode: true, foldsUnicode: true });
  if (!privateDirectories.includes(reserved)) return false;
  if (path === undefined) return !caseSensitive;
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  const other = lstatSync(join(dirname(path), reserved), { bigint: true, throwIfNoEntry: false });
  if (entry || other) return entry?.dev === other?.dev && entry?.ino === other?.ino;
  // Native path admission verifies prospective names on their nearest existing ancestor.
  return !physicalGuard && !workspaceCaseSensitivity(dirname(path));
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
 * Owns agent-visible name filters and the current host-private path exclusions.
 * Composition roots supply this policy to disk, editor and native adapters. A
 * projection belongs to one root and one policy generation. A caller retaining
 * asynchronous results must check the generation again before releasing them.
 * The filesystem adapter verifies the underlying object at the operation itself.
 */
export class WorkspaceAccessPolicy {
  readonly ignoredDirectories: readonly string[];
  /** User-configured name filters. Native services enforce mandatory private locations separately. */
  readonly configuredIgnoredDirectories: readonly string[];
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
    this.configuredIgnoredDirectories = resolved.ignoredDirectories;
    this.ignoredDirectories = [...new Set([...this.configuredIgnoredDirectories, ...privateDirectories])];
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

  /** Capture the host's private paths for one operation. Check again before publishing or returning its result. */
  beginOperation() {
    const privatePaths = this.privatePaths;
    return {
      privatePaths,
      assertCurrent: () => {
        if (this.privatePaths !== privatePaths) throw new Error('Workspace access changed during the operation.');
      },
    };
  }

  /** Project absolute host exclusions into the namespace of a single attached filesystem root. */
  exclusionsFor(
    root: string,
    caseSensitive: boolean,
    filesystem?: 'standalone' | 'native',
  ): { privateRoot: boolean; excludedPaths: string[] } {
    const key = (path: string): string => {
      const normalized = resolve(path).split(sep).join('/');
      return caseSensitive ? normalized : normalized.toLowerCase();
    };
    const rootKey = key(root);
    let privateRoot = false;
    for (let path = resolve(root); path !== dirname(path); path = dirname(path)) {
      if (isPrivateDirectory(basename(path), caseSensitive, filesystem ? path : undefined, filesystem === 'native'))
        privateRoot = true;
    }
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

  isIgnoredDirectory(name: string, caseSensitive: boolean, path?: string, physicalGuard = false): boolean {
    if (isPrivateDirectory(name, caseSensitive, path, physicalGuard)) return true;
    return this.configuredIgnoredDirectories.some(value =>
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
