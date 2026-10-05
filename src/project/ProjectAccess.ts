import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { zodResponsesFunction } from 'openai/helpers/zod';
import type { NamespaceTool } from 'openai/resources/responses/responses';
import { z } from 'zod';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';

interface ProjectAccessOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxLinesPerRead?: number;
  ignoredDirectories?: string[];
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
  ignoredDirectories: ['.git', '.next', 'coverage', 'dist', 'node_modules'],
  sensitiveFileNames: ['.netrc', '.npmrc', '.pypirc'],
  sensitiveFilePrefixes: ['.env'],
  sensitiveFileExtensions: ['.key', '.pem', '.p12', '.pfx'],
  allowedFileNames: ['.env.example'],
} as const;

const projectAccessOptionsSchema = z.object({
  maxFiles: z.number().int().positive().default(defaults.maxFiles),
  maxFileBytes: z.number().int().positive().default(defaults.maxFileBytes),
  maxLinesPerRead: z.number().int().positive().default(defaults.maxLinesPerRead),
  ignoredDirectories: z.array(z.string().min(1)).default([...defaults.ignoredDirectories]),
  sensitiveFileNames: z.array(z.string().min(1)).default([...defaults.sensitiveFileNames]),
  sensitiveFilePrefixes: z.array(z.string().min(1)).default([...defaults.sensitiveFilePrefixes]),
  sensitiveFileExtensions: z.array(z.string().regex(/^\.[^.]+$/)).default([...defaults.sensitiveFileExtensions]),
  allowedFileNames: z.array(z.string().min(1)).default([...defaults.allowedFileNames]),
}).strict();

type ResolvedProjectAccessOptions = z.output<typeof projectAccessOptionsSchema>;

const listProjectFilesArguments = z.object({}).strict();
const readProjectFileArguments = z.object({
  path: z.string().min(1).describe('Project-relative file path returned by list_project_files.'),
  start_line: z.number().int().positive().nullable().describe('First line to return, inclusive, or null for line 1.'),
  end_line: z.number().int().positive().nullable().describe('Last line to return, inclusive, or null for the configured maximum.'),
}).strict();

type ReadArguments = z.infer<typeof readProjectFileArguments>;

const listProjectFilesTool = zodResponsesFunction({
  name: ProjectToolName.LIST_FILES,
  description: 'List the files in the current project. Use this to discover relevant files before reading them.',
  parameters: listProjectFilesArguments,
});

const readProjectFileTool = zodResponsesFunction({
  name: ProjectToolName.READ_FILE,
  description: 'Read a UTF-8 text file inside the current project. Paths are relative to the project root. Pass null for both line bounds to read from the beginning.',
  parameters: readProjectFileArguments,
});

// ChatGPT-plan inference requires function tools to be grouped in a namespace
// (or introduced through an additional_tools input item).
const PROJECT_TOOLS: NamespaceTool[] = [{
  type: 'namespace',
  name: ProjectToolNamespace.PROJECT,
  description: 'Read-only tools for discovering and reading files in the current project.',
  tools: [listProjectFilesTool, readProjectFileTool],
}];

export class ProjectAccess {
  readonly tools = PROJECT_TOOLS;
  private readonly root: string;
  private readonly options: ResolvedProjectAccessOptions;

  constructor(root: string, options: ProjectAccessOptions = {}) {
    this.root = resolve(root);
    this.options = projectAccessOptionsSchema.parse(options);
  }

  async execute(name: string, rawArguments: string): Promise<string> {
    try {
      switch (name) {
        case ProjectToolName.LIST_FILES:
          listProjectFilesTool.$parseRaw(rawArguments);
          return JSON.stringify(await this.listFiles());
        case ProjectToolName.READ_FILE:
          return JSON.stringify(await this.readFile(readProjectFileTool.$parseRaw(rawArguments)));
        default:
          throw new Error(`Unknown project tool: ${name}`);
      }
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Project tool failed.',
      });
    }
  }

  private async listFiles(): Promise<{ files: string[]; truncated: boolean }> {
    const root = await realpath(this.root);
    const files: string[] = [];
    let truncated = false;

    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (files.length >= this.options.maxFiles) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;

        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!this.options.ignoredDirectories.includes(entry.name)) await visit(absolutePath);
          if (truncated) return;
        } else if (entry.isFile()) {
          const relativePath = relative(root, absolutePath).split(sep).join('/');
          if (!this.isExcludedFile(relativePath)) files.push(relativePath);
        }
      }
    };

    await visit(root);
    return { files, truncated };
  }

  private async readFile({
    path,
    start_line: requestedStart,
    end_line: requestedEnd,
  }: ReadArguments): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    content: string;
  }> {
    const startLine = requestedStart ?? 1;
    const { absolutePath, relativePath } = await this.resolveFile(path);
    const file = await stat(absolutePath);
    if (!file.isFile()) throw new Error('Path does not refer to a regular file.');
    // TODO: Read oversized files incrementally so line-range requests do not require loading the whole file.
    if (file.size > this.options.maxFileBytes) {
      throw new Error(`File exceeds the ${this.options.maxFileBytes}-byte read limit.`);
    }

    const content = await readFile(absolutePath, 'utf8');
    if (content.includes('\0')) throw new Error('Binary files cannot be read.');

    const lines = content.split(/\r?\n/);
    const endLineLimit = requestedEnd ?? startLine + this.options.maxLinesPerRead - 1;
    if (endLineLimit < startLine) throw new Error('end_line must be greater than or equal to start_line.');
    if (endLineLimit - startLine + 1 > this.options.maxLinesPerRead) {
      throw new Error(`A single read may include at most ${this.options.maxLinesPerRead} lines.`);
    }

    const startIndex = startLine - 1;
    const endLine = Math.min(endLineLimit, lines.length);
    const selected = startIndex >= lines.length ? [] : lines.slice(startIndex, endLine);
    const numbered = selected.map((line, index) => `${startLine + index}: ${line}`).join('\n');

    return {
      path: relativePath,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      content: numbered,
    };
  }

  private async resolveFile(input: string): Promise<{ absolutePath: string; relativePath: string }> {
    if (isAbsolute(input)) throw new Error('Path must be relative to the project root.');

    const root = await realpath(this.root);
    const candidate = resolve(root, input);
    assertInsideRoot(root, candidate);
    const absolutePath = await realpath(candidate);
    assertInsideRoot(root, absolutePath);

    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (relativePath.split('/').some(part => this.options.ignoredDirectories.includes(part))) {
      throw new Error('That path is excluded from project access.');
    }
    if (this.isExcludedFile(relativePath)) throw new Error('That file is excluded from project access.');
    return { absolutePath, relativePath };
  }

  private isExcludedFile(path: string): boolean {
    const name = path.split('/').at(-1) ?? '';
    if (this.options.allowedFileNames.includes(name)) return false;
    if (this.options.sensitiveFileNames.includes(name)) return true;
    if (this.options.sensitiveFilePrefixes.some(prefix => name.startsWith(prefix))) return true;
    return this.options.sensitiveFileExtensions.some(extension => name.endsWith(extension));
  }
}

function assertInsideRoot(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('Path escapes the project root.');
  }
}
