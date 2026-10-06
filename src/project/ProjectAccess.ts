import { z } from 'zod';
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
  maxLinesPerRead?: number;
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
  // Matches the model-facing read pagination default in LangChain Deep Agents.
  maxLinesPerRead: 100,
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
    maxLinesPerRead: z.number().int().positive().default(defaults.maxLinesPerRead),
    ignoredDirectories: z.array(z.string().min(1)).default([...defaults.ignoredDirectories]),
    excludedPaths: z.array(z.string().min(1)).default([...defaults.excludedPaths]),
    sensitiveFileNames: z.array(z.string().min(1)).default([...defaults.sensitiveFileNames]),
    sensitiveFilePrefixes: z.array(z.string().min(1)).default([...defaults.sensitiveFilePrefixes]),
    sensitiveFileExtensions: z.array(z.string().regex(/^\.[^.]+$/)).default([...defaults.sensitiveFileExtensions]),
    allowedFileNames: z.array(z.string().min(1)).default([...defaults.allowedFileNames]),
  })
  .strict();

type ResolvedProjectAccessOptions = z.output<typeof projectAccessOptionsSchema>;

const listProjectFilesArguments = z.object({}).strict();
const readProjectFileArguments = z
  .object({
    path: z.string().min(1).describe('Project-relative file path returned by list_project_files.'),
    start_line: z.number().int().positive().nullable().describe('First line to return, inclusive, or null for line 1.'),
    end_line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('Last line to return, inclusive, or null for the configured maximum.'),
  })
  .strict();

type ReadArguments = z.infer<typeof readProjectFileArguments>;

const definitions: readonly ToolDefinition[] = [
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.LIST_FILES,
    description: 'List the files in the current project. Use this to discover relevant files before reading them.',
    inputKind: ToolInputKind.JSON,
    parameters: jsonSchema(listProjectFilesArguments),
  },
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.READ_FILE,
    description:
      'Read an exact UTF-8 text snapshot inside the project, including its revision, byte-order-mark state, and per-line line-ending metadata. Paths are project-relative. Pass null for both line bounds to read from the beginning. Reuse the revision in edit proposals.',
    inputKind: ToolInputKind.JSON,
    parameters: jsonSchema(readProjectFileArguments),
  },
];

export class ProjectAccess {
  readonly definitions = definitions;
  private readonly options: ResolvedProjectAccessOptions;
  private readonly workspace: WorkspaceTextStore;

  constructor(root: string, options: ProjectAccessOptions = {}, workspace?: WorkspaceTextStore) {
    const { maxFiles, maxFileBytes, maxLinesPerRead, ...workspaceOptions } = projectAccessOptionsSchema.parse(options);
    this.options = { maxFiles, maxFileBytes, maxLinesPerRead, ...workspaceOptions };
    this.workspace = workspace ?? new FileSystemWorkspaceTextStore(root, workspaceOptions);
  }

  async execute(name: string, rawArguments: string): Promise<string> {
    try {
      switch (name) {
        case ProjectToolName.LIST_FILES:
          listProjectFilesArguments.parse(JSON.parse(rawArguments));
          return JSON.stringify(await this.listFiles());
        case ProjectToolName.READ_FILE:
          return JSON.stringify(await this.readFile(readProjectFileArguments.parse(JSON.parse(rawArguments))));
        default:
          throw new Error(`Unknown project tool: ${name}`);
      }
    } catch (error) {
      return JSON.stringify({
        error:
          error instanceof EditError
            ? error.toJSON()
            : {
                code:
                  error instanceof z.ZodError || error instanceof SyntaxError
                    ? EditFailureReason.MALFORMED
                    : 'PROJECT_ACCESS_FAILED',
                message: error instanceof Error ? error.message : 'Project tool failed.',
              },
      });
    }
  }

  private async listFiles(): Promise<{ files: string[]; truncated: boolean }> {
    return this.workspace.list(this.options.maxFiles);
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
    const endLineLimit = requestedEnd ?? startLine + this.options.maxLinesPerRead - 1;
    if (endLineLimit < startLine) throw new Error('end_line must be greater than or equal to start_line.');
    if (endLineLimit - startLine + 1 > this.options.maxLinesPerRead) {
      throw new Error(`A single read may include at most ${this.options.maxLinesPerRead} lines.`);
    }

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
