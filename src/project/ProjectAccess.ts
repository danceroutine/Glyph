import { z } from 'zod';
import { WorkspacePathIndexError } from '../context/search/WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from '../context/search/WorkspacePathIndexFailureReason.ts';
import type { WorkspacePathIndex } from '../context/search/WorkspacePathIndex.ts';
import type { ToolDefinition } from '../tools/ToolDefinition.ts';
import { ToolInputKind } from '../tools/ToolInputKind.ts';
import { FileSystemWorkspaceTextStore } from '../workspace/FileSystemWorkspaceTextStore.ts';
import type { WorkspaceTextStore } from '../workspace/WorkspaceTextStore.ts';
import { EditError } from '../editing/errors/EditError.ts';
import { EditFailureReason } from '../editing/errors/EditFailureReason.ts';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';

interface ProjectAccessOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  ignoredDirectories?: string[];
  excludedPaths?: string[];
  sensitiveFileNames?: string[];
  sensitiveFilePrefixes?: string[];
  sensitiveFileExtensions?: string[];
  allowedFileNames?: string[];
}

const defaults = {
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  ignoredDirectories: ['.git', '.next', 'coverage', 'dist', 'node_modules', 'target'],
  excludedPaths: [],
  sensitiveFileNames: ['.netrc', '.npmrc', '.pypirc'],
  sensitiveFilePrefixes: ['.env'],
  sensitiveFileExtensions: ['.key', '.pem', '.p12', '.pfx'],
  allowedFileNames: ['.env.example'],
} as const;

const projectAccessOptionsSchema = z
  .object({
    maxFiles: z.number().int().positive().default(defaults.maxFiles),
    maxFileBytes: z.number().int().positive().default(defaults.maxFileBytes),
    ignoredDirectories: z.array(z.string().min(1)).default([...defaults.ignoredDirectories]),
    excludedPaths: z.array(z.string().min(1)).default([...defaults.excludedPaths]),
    sensitiveFileNames: z.array(z.string().min(1)).default([...defaults.sensitiveFileNames]),
    sensitiveFilePrefixes: z.array(z.string().min(1)).default([...defaults.sensitiveFilePrefixes]),
    sensitiveFileExtensions: z.array(z.string().regex(/^\.[^.]+$/)).default([...defaults.sensitiveFileExtensions]),
    allowedFileNames: z.array(z.string().min(1)).default([...defaults.allowedFileNames]),
  })
  .strict();

type ResolvedProjectAccessOptions = z.output<typeof projectAccessOptionsSchema>;

const listProjectFilesArguments = z
  .object({
    glob_pattern: z
      .string()
      .min(1)
      .max(4_096)
      .describe('Glob pattern for file paths. Patterns without a **/ prefix match at any depth.'),
    target_directory: z
      .string()
      .min(1)
      .nullable()
      .describe('Project-relative directory to search, or null for the project root.'),
  })
  .strict();
const readProjectFileArguments = z
  .object({
    path: z.string().min(1).describe('Project-relative file path returned by list_project_files.'),
    start_line: z.number().int().positive().nullable().describe('First line to return, inclusive, or null for line 1.'),
    end_line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('Last line to return, inclusive, or null for the end of the file.'),
  })
  .strict();
const searchProjectContentsArguments = z
  .object({
    pattern: z.string().min(1).max(4_096).describe('Text or Rust/ripgrep regular expression to find.'),
    pattern_kind: z
      .enum(['regular_expression', 'literal'])
      .describe('Whether pattern is a regular expression or exact literal text.'),
    path: z.string().min(1).nullable().describe('Project-relative file or directory, or null for the project root.'),
    file_glob: z
      .string()
      .min(1)
      .max(4_096)
      .nullable()
      .describe('Optional glob filter such as *.{ts,tsx}; unprefixed patterns match at any depth.'),
    file_type: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .describe('Optional ripgrep file type such as ts or py.'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']),
    lines_before: z.number().int().min(0).max(20),
    lines_after: z.number().int().min(0).max(20),
    case_sensitive: z.boolean(),
    multiline: z.boolean().describe('Allow matches to span lines and make dot match line endings.'),
    limit: z.number().int().min(1).max(1_000),
    offset: z.number().int().min(0).max(100_000),
  })
  .strict();
const resolvedSearchProjectContentsArguments = searchProjectContentsArguments.transform(
  ({
    pattern,
    pattern_kind: patternKind,
    path,
    file_glob: fileGlob,
    file_type: fileType,
    output_mode: outputMode,
    lines_before: linesBefore,
    lines_after: linesAfter,
    case_sensitive: caseSensitive,
    multiline,
    limit,
    offset,
  }) => ({
    pattern,
    options: {
      patternKind,
      path,
      fileGlob,
      fileType,
      outputMode,
      linesBefore,
      linesAfter,
      caseSensitive,
      multiline,
      limit,
      offset,
    },
  }),
);

type ReadArguments = z.infer<typeof readProjectFileArguments>;

const definitions: readonly ToolDefinition[] = [
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.LIST_FILES,
    description:
      'Find project files by glob pattern within an optional project-relative directory. Patterns without a **/ prefix match at any depth. Results preserve project access exclusions.',
    inputKind: ToolInputKind.JSON,
    parameters: jsonSchema(listProjectFilesArguments),
  },
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.READ_FILE,
    description:
      'Read an exact UTF-8 text snapshot inside the project, including its revision, byte-order-mark state, and per-line line-ending metadata. Paths are project-relative. Pass null for both line bounds to read the entire file. Reuse the revision in edit proposals.',
    inputKind: ToolInputKind.JSON,
    parameters: jsonSchema(readProjectFileArguments),
  },
];

const searchDefinition: ToolDefinition = {
  namespace: ProjectToolNamespace.PROJECT,
  name: ProjectToolName.SEARCH_CONTENTS,
  description:
    'Search current project file contents with the native ripgrep engine. Scope by project-relative path, glob, or file type. Prefer literal patterns unless regular-expression behavior is needed. Results preserve project access exclusions.',
  inputKind: ToolInputKind.JSON,
  parameters: jsonSchema(searchProjectContentsArguments),
};

export class ProjectAccess {
  readonly definitions: readonly ToolDefinition[];
  private readonly options: ResolvedProjectAccessOptions;
  private readonly workspace: WorkspaceTextStore;

  constructor(
    root: string,
    options: ProjectAccessOptions = {},
    workspace?: WorkspaceTextStore,
    private readonly pathIndex?: Pick<WorkspacePathIndex, 'glob'> & Partial<Pick<WorkspacePathIndex, 'searchContents'>>,
  ) {
    const { maxFiles, maxFileBytes, ...workspaceOptions } = projectAccessOptionsSchema.parse(options);
    this.options = { maxFiles, maxFileBytes, ...workspaceOptions };
    this.workspace = workspace ?? new FileSystemWorkspaceTextStore(root, workspaceOptions);
    this.definitions = this.pathIndex?.searchContents ? [...definitions, searchDefinition] : definitions;
  }

  async execute(name: string, rawArguments: string, signal?: AbortSignal): Promise<string> {
    try {
      switch (name) {
        case ProjectToolName.LIST_FILES:
          return JSON.stringify(await this.listFiles(listProjectFilesArguments.parse(JSON.parse(rawArguments))));
        case ProjectToolName.READ_FILE:
          return JSON.stringify(await this.readFile(readProjectFileArguments.parse(JSON.parse(rawArguments))));
        case ProjectToolName.SEARCH_CONTENTS:
          return JSON.stringify(
            await this.searchContents(resolvedSearchProjectContentsArguments.parse(JSON.parse(rawArguments)), signal),
          );
        default:
          throw new Error(`Unknown project tool: ${name}`);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return JSON.stringify({
        error:
          error instanceof EditError
            ? error.toJSON()
            : {
                code:
                  error instanceof z.ZodError ||
                  error instanceof SyntaxError ||
                  (error instanceof WorkspacePathIndexError &&
                    error.code === WorkspacePathIndexFailureReason.INVALID_REQUEST)
                    ? EditFailureReason.MALFORMED
                    : 'PROJECT_ACCESS_FAILED',
                message: error instanceof Error ? error.message : 'Project tool failed.',
              },
      });
    }
  }

  private async searchContents(
    { pattern, options }: z.output<typeof resolvedSearchProjectContentsArguments>,
    signal?: AbortSignal,
  ) {
    const pathIndex = this.pathIndex;
    if (!pathIndex?.searchContents) throw new Error('Native project content search is unavailable.');
    return pathIndex.searchContents(pattern, {
      ...options,
      path: options.path === null ? null : this.workspace.normalizePath(options.path),
      signal,
    });
  }

  private async listFiles({
    glob_pattern: globPattern,
    target_directory: targetDirectory,
  }: z.infer<typeof listProjectFilesArguments>): Promise<{ files: string[]; truncated: boolean }> {
    const normalizedTarget = targetDirectory === null ? undefined : this.workspace.normalizePath(targetDirectory);
    if (this.pathIndex) {
      return this.pathIndex.glob(globPattern, {
        ...(normalizedTarget === undefined ? {} : { targetDirectory: normalizedTarget }),
        limit: this.options.maxFiles,
      });
    }
    return this.workspace.list(this.options.maxFiles, globPattern, normalizedTarget);
  }

  private async readFile({ path, start_line: requestedStart, end_line: requestedEnd }: ReadArguments): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    content: string;
    revision: string;
    byteOrderMark: boolean;
    lines: { number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }[];
  }> {
    const startLine = requestedStart ?? 1;
    const snapshot = await this.workspace.read(path);
    // TODO: Read oversized files incrementally so line-range requests do not require loading the whole file.
    if (snapshot.byteLength > this.options.maxFileBytes) {
      throw new Error(`File exceeds the ${this.options.maxFileBytes}-byte read limit.`);
    }
    const lines = toLines(snapshot.text);
    const endLineLimit = requestedEnd ?? lines.length;
    if (endLineLimit < startLine) throw new Error('end_line must be greater than or equal to start_line.');

    const startIndex = startLine - 1;
    const endLine = Math.min(endLineLimit, lines.length);
    const selected = startIndex >= lines.length ? [] : lines.slice(startIndex, endLine);
    const numbered = selected.map(line => `${line.number}: ${line.content}`).join('\n');

    return {
      path: snapshot.path,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      content: numbered,
      revision: snapshot.revision,
      byteOrderMark: snapshot.byteOrderMark,
      lines: selected,
    };
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' });
  return parameters;
}

function toLines(text: string): { number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }[] {
  const lines: { number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character !== '\n' && character !== '\r') continue;
    const lineEnding = character === '\r' && text[index + 1] === '\n' ? '\r\n' : character;
    lines.push({ number: number++, content: text.slice(start, index), lineEnding });
    if (lineEnding === '\r\n') index++;
    start = index + 1;
  }
  lines.push({ number, content: text.slice(start), lineEnding: '' });
  return lines;
}
