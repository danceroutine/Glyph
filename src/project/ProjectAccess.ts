import { searchTextSource, type SearchFileIdentity } from '#src/context/search/WorkspaceContentSearchResult.js';
import type { PinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import { WorkspaceDisclosure } from '#src/workspace/WorkspaceDisclosure.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.js';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';
import { isEnumValue } from '#src/shared/validators/isEnumValue.js';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';

interface ProjectAccessOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const defaults = {
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
} as const;

const projectAccessOptionsSchema = z
  .object({
    maxFiles: z.number().int().positive().default(defaults.maxFiles),
    maxFileBytes: z.number().int().positive().default(defaults.maxFileBytes),
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
      .regex(/^[A-Za-z0-9_-]+$/u)
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

export class ProjectAccess {
  private readonly options: ResolvedProjectAccessOptions;

  constructor(
    private readonly workspace: Pick<WorkspaceTextStore, 'read' | 'normalizePath'>,
    private readonly pathIndex: Pick<WorkspacePathIndex, 'glob'> & Partial<Pick<WorkspacePathIndex, 'searchContents'>>,
    options: ProjectAccessOptions = {},
    private readonly turnContexts?: Pick<TurnContextCoordinator, 'disclosePaths'>,
    private readonly sourceAuthority?: PinnedSourceAuthority,
  ) {
    this.options = projectAccessOptionsSchema.parse(options);
  }

  get tools(): readonly Tool[] {
    const tools: Tool[] = [
      {
        namespace: ProjectToolNamespace.PROJECT,
        name: ProjectToolName.LIST_FILES,
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        description:
          'Find project files by glob pattern within an optional project-relative directory. Patterns without a **/ prefix match at any depth. Results preserve project access exclusions.',
        inputKind: ToolInputKind.JSON,
        parameters: jsonSchema(listProjectFilesArguments),
        validateInput: input => {
          listProjectFilesArguments.parse(JSON.parse(input));
        },
        execute: (input, signal, context) => this.execute(ProjectToolName.LIST_FILES, input, signal, context),
      },
      {
        namespace: ProjectToolNamespace.PROJECT,
        name: ProjectToolName.READ_FILE,
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        description:
          'Read a UTF-8 text snapshot inside the project, including revision, byte-order-mark state, and per-line line-ending metadata. Paths are project-relative. Results are bounded to 512 KiB; when nextStartLine is present, request that start_line to continue. Reuse the revision in edit proposals.',
        inputKind: ToolInputKind.JSON,
        parameters: jsonSchema(readProjectFileArguments),
        validateInput: input => {
          readProjectFileArguments.parse(JSON.parse(input));
        },
        execute: (input, signal, context) => this.execute(ProjectToolName.READ_FILE, input, signal, context),
      },
    ];
    if (this.pathIndex.searchContents)
      tools.push({
        namespace: ProjectToolNamespace.PROJECT,
        name: ProjectToolName.SEARCH_CONTENTS,
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        description:
          'Search current project file contents with the native ripgrep engine. Scope by project-relative path, glob, or file type. Prefer literal patterns unless regular-expression behavior is needed. Results preserve project access exclusions.',
        inputKind: ToolInputKind.JSON,
        parameters: jsonSchema(searchProjectContentsArguments),
        validateInput: input => {
          resolvedSearchProjectContentsArguments.parse(JSON.parse(input));
        },
        execute: (input, signal, context) => this.execute(ProjectToolName.SEARCH_CONTENTS, input, signal, context),
      });
    return tools;
  }

  async execute(
    name: string,
    rawArguments: string,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const access = new WorkspaceDisclosure();
    const deliver = (value: object) => {
      signal?.throwIfAborted();
      access.assertCurrent();
      if (access.hasSources)
        context?.retainResultAccess?.(
          access.assertCurrent,
          access.hasValidators ? cancellation => access.authorize(cancellation) : undefined,
        );
      return JSON.stringify(value);
    };
    try {
      switch (isEnumValue(ProjectToolName, name) ? name : undefined) {
        case ProjectToolName.LIST_FILES:
          return deliver(
            await this.listFiles(listProjectFilesArguments.parse(JSON.parse(rawArguments)), access, signal),
          );
        case ProjectToolName.READ_FILE: {
          const arguments_ = readProjectFileArguments.parse(JSON.parse(rawArguments));
          const result = await this.readFile(arguments_, access);
          return deliver(await this.withInstructions(result, [result.path], context, signal));
        }
        case ProjectToolName.SEARCH_CONTENTS: {
          const result = await this.searchContents(
            resolvedSearchProjectContentsArguments.parse(JSON.parse(rawArguments)),
            access,
            signal,
          );
          return deliver(await this.withInstructions(result, searchResultPaths(result), context, signal));
        }
        default:
          throw new Error(`Unknown project tool: ${name}`);
      }
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
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

  private async withInstructions(
    result: object,
    paths: readonly string[],
    context?: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<object> {
    const instructions = context?.turnId
      ? await this.turnContexts?.disclosePaths(context.turnId, paths, signal)
      : undefined;
    return instructions ? { ...result, instructionContext: instructions } : result;
  }

  private async searchContents(
    { pattern, options }: z.output<typeof resolvedSearchProjectContentsArguments>,
    access: WorkspaceDisclosure,
    signal?: AbortSignal,
  ) {
    const pathIndex = this.pathIndex;
    if (!pathIndex.searchContents) throw new Error('Native project content search is unavailable.');
    const authority = this.sourceAuthority;
    const result = await pathIndex.searchContents(pattern, {
      ...(authority && { sourceAuthority: authority }),
      ...options,
      retainAccess: access.retain,
      path: options.path === null ? null : this.workspace.normalizePath(options.path),
      signal,
    });
    if (authority && result.outputMode === 'content') {
      const disk: SearchFileIdentity[] = [];
      const editors = new Set<WorkspaceDisclosure>();
      for (const match of result.matches) {
        const source = match[searchTextSource];
        if (!source) throw new Error('The source of a search match is unavailable.');
        if (source instanceof WorkspaceDisclosure) editors.add(source);
        else disk.push(source);
      }
      await access.retainFiles(authority, disk, signal);
      for (const editor of editors) access.revalidate(cancellation => editor.authorize(cancellation));
    }
    return result;
  }

  private async listFiles(
    { glob_pattern: globPattern, target_directory: targetDirectory }: z.infer<typeof listProjectFilesArguments>,
    access: WorkspaceDisclosure,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; truncated: boolean }> {
    signal?.throwIfAborted();
    const normalizedTarget = targetDirectory === null ? undefined : this.workspace.normalizePath(targetDirectory);
    return this.pathIndex.glob(globPattern, {
      retainAccess: access.retain,
      ...(normalizedTarget === undefined ? {} : { targetDirectory: normalizedTarget }),
      limit: this.options.maxFiles,
      ...(signal ? { signal } : {}),
    });
  }

  private async readFile(
    { path, start_line: requestedStart, end_line: requestedEnd }: ReadArguments,
    access: WorkspaceDisclosure,
  ): Promise<{
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
    const snapshot = await this.workspace.read(path, {
      maxBytes: this.options.maxFileBytes,
      ...(this.sourceAuthority && { source: { authority: this.sourceAuthority, disclosure: access } }),
      retainAccess: access.retain,
    });
    // Follow-up: read oversized files incrementally so line-range requests do not load the whole file.
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
        if (selected.length === 0) throw new Error('This line exceeds the 512 KiB serialized read limit.');
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

function searchResultPaths(result: Awaited<ReturnType<WorkspacePathIndex['searchContents']>>): readonly string[] {
  switch (result.outputMode) {
    case 'content':
      return result.matches.map(match => match.path);
    case 'files_with_matches':
      return result.files;
    case 'count':
      return result.counts.map(count => count.path);
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
