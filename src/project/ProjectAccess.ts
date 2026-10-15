import { z } from 'zod';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.js';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { ToolDefinition } from '#src/tools/ToolDefinition.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';

interface ProjectAccessOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  excludedPaths?: string[];
  accessPolicy?: WorkspaceAccessPolicy;
}

const defaults = {
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  excludedPaths: [],
} as const;

const projectAccessOptionsSchema = z
  .object({
    maxFiles: z.number().int().positive().default(defaults.maxFiles),
    maxFileBytes: z.number().int().positive().default(defaults.maxFileBytes),
    excludedPaths: z.array(z.string().min(1)).default([...defaults.excludedPaths]),
    accessPolicy: z.instanceof(WorkspaceAccessPolicy).default(() => new WorkspaceAccessPolicy()),
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
      'Read a UTF-8 text snapshot inside the project, including revision, byte-order-mark state, and per-line line-ending metadata. Paths are project-relative. Results are bounded to 512 KiB; when nextStartLine is present, request that start_line to continue. Reuse the revision in edit proposals.',
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
    const { maxFiles, maxFileBytes, excludedPaths, accessPolicy } = projectAccessOptionsSchema.parse(options);
    this.options = { maxFiles, maxFileBytes, excludedPaths, accessPolicy };
    this.workspace = workspace ?? new FileSystemWorkspaceTextStore(root, { excludedPaths, accessPolicy });
    this.definitions = this.pathIndex?.searchContents ? [...definitions, searchDefinition] : definitions;
  }

  async execute(name: string, rawArguments: string, signal?: AbortSignal): Promise<string> {
    try {
      switch (name) {
        case ProjectToolName.LIST_FILES:
          return JSON.stringify(
            await this.listFiles(listProjectFilesArguments.parse(JSON.parse(rawArguments)), signal),
          );
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

  private async listFiles(
    { glob_pattern: globPattern, target_directory: targetDirectory }: z.infer<typeof listProjectFilesArguments>,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }> {
    signal?.throwIfAborted();
    const normalizedTarget = targetDirectory === null ? undefined : this.workspace.normalizePath(targetDirectory);
    if (this.pathIndex) {
      return this.pathIndex.glob(globPattern, {
        ...(normalizedTarget === undefined ? {} : { targetDirectory: normalizedTarget }),
        limit: this.options.maxFiles,
        ...(signal ? { signal } : {}),
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
    nextStartLine?: number;
    content: string;
    revision: string;
    byteOrderMark: boolean;
    lines: { number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }[];
  }> {
    const startLine = requestedStart ?? 1;
    const snapshot = await this.workspace.read(path, { maxBytes: this.options.maxFileBytes });
    // TODO: Read oversized files incrementally so line-range requests do not require loading the whole file.
    if (snapshot.byteLength > this.options.maxFileBytes) {
      throw new Error(`File exceeds the ${this.options.maxFileBytes}-byte read limit.`);
    }
    const endLineLimit = requestedEnd ?? Number.MAX_SAFE_INTEGER;
    if (endLineLimit < startLine) throw new Error('end_line must be greater than or equal to start_line.');

    const selected: { number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }[] = [];
    const numbered: string[] = [];
    let totalLines = 0;
    let budgetFull = false;
    // Reserve scalar metadata conservatively, then account for both copies of
    // each line using JSON-escaped byte sizes. Never allocate a whole-file array
    // of line objects merely to return a small page.
    let bytes = Buffer.byteLength(JSON.stringify({ path: snapshot.path, revision: snapshot.revision })) + 512;
    for (const line of toLines(snapshot.text)) {
      totalLines = line.number;
      if (line.number < startLine || line.number > endLineLimit || budgetFull) continue;
      const numberedLine = `${line.number}: ${line.content}`;
      const added = Buffer.byteLength(JSON.stringify(line)) + Buffer.byteLength(JSON.stringify(numberedLine)) + 3;
      if (bytes + added > 512 * 1024) {
        if (!selected.length) throw new Error('This line exceeds the 512 KiB serialized read limit.');
        budgetFull = true;
        continue;
      }
      bytes += added;
      selected.push(line);
      numbered.push(numberedLine);
    }
    const endLine = selected.at(-1)?.number ?? Math.min(endLineLimit, totalLines);

    return {
      path: snapshot.path,
      startLine,
      endLine,
      totalLines,
      truncated: endLine < totalLines,
      ...(budgetFull ? { nextStartLine: endLine + 1 } : {}),
      content: numbered.join('\n'),
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

function* toLines(text: string): Generator<{ number: number; content: string; lineEnding: '' | '\n' | '\r\n' | '\r' }> {
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character !== '\n' && character !== '\r') continue;
    const lineEnding = character === '\r' && text[index + 1] === '\n' ? '\r\n' : character;
    yield { number: number++, content: text.slice(start, index), lineEnding };
    if (lineEnding === '\r\n') index++;
    start = index + 1;
  }
  yield { number, content: text.slice(start), lineEnding: '' };
}
