import { lstat, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { ConfigurationError } from '../../errors/ConfigurationError.ts';
import type { ProjectContext } from './ProjectContext.ts';
import { ProjectContextIdentity } from './ProjectContextIdentity.ts';
import { ProjectContextKind } from './ProjectContextKind.ts';
import type { ProjectRoot } from './ProjectRoot.ts';

const workspaceSchema = z
  .object({
    folders: z
      .array(
        z.union([
          z.object({ path: z.string().min(1), name: z.string().min(1).optional() }),
          z.object({ uri: z.url(), name: z.string().min(1).optional() }),
        ]),
      )
      .min(1),
  })
  .passthrough();

export interface ResolveProjectContextOptions {
  readonly currentDirectory: string;
  readonly workspaceFile?: string;
  readonly authority?: string;
}

/** Resolves terminal launch arguments into the context inherited by every chat and project tool. */
export class ProjectContextResolver {
  static async resolve(options: ResolveProjectContextOptions): Promise<ProjectContext> {
    const authority = options.authority ?? defaultAuthority();
    return options.workspaceFile
      ? this.workspace(options.workspaceFile, options.currentDirectory, authority)
      : this.folder(options.currentDirectory, authority);
  }

  static async folder(path: string, authority = defaultAuthority()): Promise<ProjectContext> {
    const root = await canonicalDirectory(path);
    const roots = [{ name: basename(root), path: root }];
    return {
      id: ProjectContextIdentity.create(ProjectContextKind.FOLDER, authority, root),
      mutationIdentity: ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, authority, roots),
      kind: ProjectContextKind.FOLDER,
      name: basename(root),
      authority,
      roots,
    };
  }

  static async workspace(
    workspaceFile: string,
    currentDirectory: string,
    authority = defaultAuthority(),
  ): Promise<ProjectContext> {
    const manifest = await realpath(resolve(currentDirectory, workspaceFile));
    const errors: ParseError[] = [];
    const raw = await readFile(manifest, 'utf8');
    const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const details = errors.map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(', ');
      throw new ConfigurationError(`Could not parse workspace file ${manifest}: ${details}.`);
    }
    const result = workspaceSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigurationError(`Invalid workspace file ${manifest}:\n${z.prettifyError(result.error)}`);
    }
    const roots = await Promise.all(
      result.data.folders.map(async folder => ({
        name: folder.name ?? basename('path' in folder ? folder.path : new URL(folder.uri).pathname),
        path: await resolveFolderLocation(folder, manifest),
      })),
    );
    validateRootNames(roots, manifest);
    const name = basename(manifest, extname(manifest));
    return {
      id: ProjectContextIdentity.create(ProjectContextKind.WORKSPACE, authority, manifest),
      mutationIdentity: ProjectContextIdentity.createMutationScope(ProjectContextKind.WORKSPACE, authority, roots),
      kind: ProjectContextKind.WORKSPACE,
      name,
      authority,
      roots,
      workspaceFile: manifest,
    };
  }
}

async function resolveFolderLocation(
  folder: z.infer<typeof workspaceSchema>['folders'][number],
  manifest: string,
): Promise<string> {
  if ('path' in folder) return canonicalDirectory(resolve(dirname(manifest), folder.path));
  const uri = new URL(folder.uri);
  if (uri.protocol === 'file:') return canonicalDirectory(fileURLToPath(uri));
  if (uri.protocol === 'vscode-remote:') return canonicalDirectory(decodeURIComponent(uri.pathname));
  throw new ConfigurationError(`Workspace ${manifest} contains unsupported folder URI: ${folder.uri}`);
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await lstat(canonical)).isDirectory()) {
    throw new ConfigurationError(`Project root is not a directory: ${canonical}`);
  }
  return canonical;
}

function validateRootNames(roots: readonly ProjectRoot[], workspaceFile: string): void {
  const names = new Set<string>();
  for (const root of roots) {
    if (!root.name.trim() || /[/\\\u0000-\u001f\u007f]/u.test(root.name)) {
      throw new ConfigurationError(`Workspace ${workspaceFile} contains an invalid folder name: ${root.name}`);
    }
    const folded = root.name.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(folded)) {
      throw new ConfigurationError(`Workspace ${workspaceFile} contains duplicate folder name: ${root.name}`);
    }
    names.add(folded);
  }
}

function defaultAuthority(): string {
  return process.env.SSH_CONNECTION ? `ssh:${hostname()}` : 'local';
}
