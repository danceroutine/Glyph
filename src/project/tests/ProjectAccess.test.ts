import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.js';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';

type ProjectOutput = {
  nextStartLine: number;
  endLine: number;
  truncated: boolean;
  lines: { number: number; content: string }[];
  matches: unknown[];
  files: string[];
  error: { message: string };
};

async function fixture(): Promise<{ access: ProjectAccess; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-project-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'README.md'), '# Sample\n');
  await writeFile(join(root, '.env'), 'SECRET=hidden');
  await writeFile(join(root, '.git-credentials'), 'https://user:token@example.test');
  await writeFile(join(root, '.env.example'), 'SECRET=');
  await writeFile(join(root, 'src', 'app.ts'), ['one', 'two', 'three', 'four'].join('\n'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored');
  await writeFile(join(root, 'target', 'native-artifact'), 'ignored');
  return { access: new ProjectAccess(root), root };
}

describe(ProjectAccess, () => {
  it('counts escaped and multibyte text in the read-result budget', async () => {
    const workspace = new FileSystemWorkspaceTextStore('/fixture');
    const text = '😀\t"\\\n'.repeat(30_000);
    vi.spyOn(workspace, 'read').mockResolvedValue({
      path: 'escaped.txt',
      text,
      byteOrderMark: false,
      mode: 0o644,
      identity: 'fixture',
      revision: 'revision',
      byteLength: Buffer.byteLength(text),
    });
    const result = await new ProjectAccess('/fixture', {}, workspace).execute(
      'read_project_file',
      JSON.stringify({ path: 'escaped.txt', start_line: null, end_line: null }),
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(512 * 1024);
    const page = JSON.parse(result) as ProjectOutput;
    expect(page.nextStartLine).toBeGreaterThan(1);
    expect(page.lines[0]!.content).toBe('😀\t"\\');
  });

  it('bounds serialized line metadata and numbered content and exposes the next unread line', async () => {
    const workspace = new FileSystemWorkspaceTextStore('/fixture');
    vi.spyOn(workspace, 'read').mockResolvedValue({
      path: 'many-lines.txt',
      text: '\n'.repeat(512 * 1024),
      byteOrderMark: false,
      mode: 0o644,
      identity: 'fixture',
      revision: 'revision',
      byteLength: 512 * 1024,
    });
    const access = new ProjectAccess('/fixture', {}, workspace);
    const read = (start_line: number) =>
      access.execute('read_project_file', JSON.stringify({ path: 'many-lines.txt', start_line, end_line: null }));
    const result = await read(1);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(512 * 1024);
    const page = JSON.parse(result) as ProjectOutput;
    expect(page.truncated).toBe(true);
    expect(page.nextStartLine).toBe(page.endLine + 1);
    const next = JSON.parse(await read(page.nextStartLine)) as ProjectOutput;
    expect(next.lines[0]!.number).toBe(page.nextStartLine);
    expect(next.endLine).toBeGreaterThan(page.endLine);
  });

  it('attaches newly applicable scoped instructions to reads only once per turn', async () => {
    const workspace = new FileSystemWorkspaceTextStore('/fixture');
    vi.spyOn(workspace, 'read').mockResolvedValue({
      path: 'src/app.ts',
      text: 'content',
      byteOrderMark: false,
      mode: 0o644,
      identity: 'fixture',
      revision: 'revision',
      byteLength: 7,
    });
    const disclosePaths = vi
      .fn()
      .mockReturnValueOnce({ schema: 'glyph.agent-instructions.v1', sources: [{ path: 'src/AGENTS.md' }] })
      .mockReturnValueOnce(undefined);
    const access = new ProjectAccess('/fixture', {}, workspace, undefined, { disclosePaths });
    const input = JSON.stringify({ path: 'src/app.ts', start_line: null, end_line: null });

    expect(JSON.parse(await access.execute('read_project_file', input, undefined, { turnId: 'turn' }))).toMatchObject({
      instructionContext: { sources: [{ path: 'src/AGENTS.md' }] },
    });
    expect(
      JSON.parse(await access.execute('read_project_file', input, undefined, { turnId: 'turn' })),
    ).not.toHaveProperty('instructionContext');
    expect(disclosePaths).toHaveBeenNthCalledWith(1, 'turn', ['src/app.ts']);
  });

  it('forwards listing cancellation to the native index without waiting for a worker reply', async () => {
    let release!: () => void;
    const glob = vi.fn(
      (_pattern: string, options: { signal?: AbortSignal }) =>
        new Promise<{ files: string[]; truncated: boolean }>((resolve, reject) => {
          release = () => {
            resolve({ files: [], truncated: false });
          };
          options.signal?.addEventListener(
            'abort',
            () => {
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const access = new ProjectAccess('/fixture', {}, undefined, { glob });
    const controller = new AbortController();
    let outcome: unknown;
    const listing = access
      .execute('list_project_files', '{"glob_pattern":"**/*","target_directory":null}', controller.signal)
      .then(
        value => {
          outcome = value;
        },
        error => {
          outcome = error;
        },
      );
    const cancelled = new Error('Listing cancelled');
    controller.abort(cancelled);
    try {
      await vi.waitFor(
        () => {
          expect(outcome).toBe(cancelled);
        },
        { timeout: 100 },
      );
      expect(glob.mock.calls[0]?.[1].signal).toBe(controller.signal);
    } finally {
      release();
      await listing;
    }
  });
  describe(ProjectAccess.prototype.execute, () => {
    it('finds project files by glob while excluding generated and dependency directories', async () => {
      const { access, root } = await fixture();
      await symlink(join(root, 'README.md'), join(root, 'linked-readme'));

      const result = JSON.parse(
        await access.execute(
          'list_project_files',
          JSON.stringify({ glob_pattern: '**/{*,.*}', target_directory: null }),
        ),
      ) as {
        files: string[];
        truncated: boolean;
      };
      expect(result).toEqual({ files: ['.env.example', 'README.md', 'src/app.ts'], truncated: false });
    });

    it('matches within a project-relative target directory and makes unprefixed patterns recursive', async () => {
      const { access, root } = await fixture();
      await mkdir(join(root, 'src', 'nested'));
      await mkdir(join(root, 'tests'));
      await writeFile(join(root, 'src', 'component.tsx'), 'export {}');
      await writeFile(join(root, 'src', 'nested', 'view.tsx'), 'export {}');
      await writeFile(join(root, 'tests', 'outside.tsx'), 'export {}');

      const result = JSON.parse(
        await access.execute('list_project_files', JSON.stringify({ glob_pattern: '*.tsx', target_directory: 'src' })),
      ) as { files: string[]; truncated: boolean };

      expect(result).toEqual({
        files: ['src/component.tsx', 'src/nested/view.tsx'],
        truncated: false,
      });
    });

    it('applies its result limit to glob matches instead of unrelated files encountered first', async () => {
      const { root } = await fixture();
      await writeFile(join(root, 'src', 'second.ts'), 'export {}');
      const access = new ProjectAccess(root, { maxFiles: 1 });

      const result = JSON.parse(
        await access.execute('list_project_files', JSON.stringify({ glob_pattern: '*.ts', target_directory: 'src' })),
      ) as { files: string[]; truncated: boolean };

      expect(result).toEqual({ files: ['src/app.ts'], truncated: true });
    });

    it('delegates glob discovery to the shared path index when one is available', async () => {
      const { root } = await fixture();
      const workspace = new FileSystemWorkspaceTextStore(root);
      const glob = vi.fn(async () => ({ files: ['src/app.ts'], truncated: false }));
      const access = new ProjectAccess(root, { maxFiles: 37 }, workspace, { glob });

      const result = JSON.parse(
        await access.execute('list_project_files', JSON.stringify({ glob_pattern: '*.ts', target_directory: 'src' })),
      ) as ProjectOutput;

      expect(result).toEqual({ files: ['src/app.ts'], truncated: false });
      expect(glob).toHaveBeenCalledWith('*.ts', { targetDirectory: 'src', limit: 37 });
    });

    it('exposes structured native content search with readable filters and pagination', async () => {
      const { root } = await fixture();
      const workspace = new FileSystemWorkspaceTextStore(root);
      const searchContents = vi.fn(async () => ({
        outputMode: 'content' as const,
        matches: [
          {
            path: 'src/app.ts',
            line: 2,
            column: 1,
            endLine: 2,
            endColumn: 4,
            lineText: 'two',
            matchedText: 'two',
            linesBefore: [{ number: 1, content: 'one' }],
            linesAfter: [{ number: 3, content: 'three' }],
          },
        ],
        searchedFiles: 1,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: false,
        nextOffset: null,
      }));
      const access = new ProjectAccess(root, {}, workspace, {
        glob: async () => ({ files: [], truncated: false }),
        searchContents,
      });
      const controller = new AbortController();

      const result = JSON.parse(
        await access.execute(
          'search_project_contents',
          JSON.stringify({
            pattern: 'two',
            pattern_kind: 'literal',
            path: 'src',
            file_glob: '*.ts',
            file_type: 'ts',
            output_mode: 'content',
            lines_before: 1,
            lines_after: 1,
            case_sensitive: true,
            multiline: false,
            limit: 50,
            offset: 0,
          }),
          controller.signal,
        ),
      ) as ProjectOutput;

      const definition = access.tools.find(candidate => candidate.name === 'search_project_contents');
      expect(definition?.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: [
          'pattern',
          'pattern_kind',
          'path',
          'file_glob',
          'file_type',
          'output_mode',
          'lines_before',
          'lines_after',
          'case_sensitive',
          'multiline',
          'limit',
          'offset',
        ],
      });
      expect(result.matches).toEqual([expect.objectContaining({ path: 'src/app.ts', matchedText: 'two' })]);
      expect(searchContents).toHaveBeenCalledWith('two', {
        patternKind: 'literal',
        path: 'src',
        fileGlob: '*.ts',
        fileType: 'ts',
        outputMode: 'content',
        linesBefore: 1,
        linesAfter: 1,
        caseSensitive: true,
        multiline: false,
        limit: 50,
        offset: 0,
        signal: controller.signal,
      });
    });

    it('discloses scoped instructions for files returned by count searches', async () => {
      const disclosePaths = vi.fn().mockReturnValue({
        schema: 'glyph.agent-instructions.v1',
        sources: [{ path: 'src/AGENTS.md' }],
      });
      const access = new ProjectAccess(
        tmpdir(),
        {},
        undefined,
        {
          glob: async () => ({ files: [], truncated: false }),
          searchContents: async () => ({
            outputMode: 'count',
            counts: [{ path: 'src/app.ts', count: 2 }],
            searchedFiles: 1,
            skippedFiles: 0,
            indexTruncated: false,
            truncated: false,
            nextOffset: null,
          }),
        },
        { disclosePaths },
      );

      const result = JSON.parse(
        await access.execute(
          'search_project_contents',
          JSON.stringify({
            pattern: 'needle',
            pattern_kind: 'literal',
            path: null,
            file_glob: null,
            file_type: null,
            output_mode: 'count',
            lines_before: 0,
            lines_after: 0,
            case_sensitive: true,
            multiline: false,
            limit: 10,
            offset: 0,
          }),
          undefined,
          { turnId: 'turn' },
        ),
      ) as { instructionContext: { sources: { path: string }[] } };

      expect(result.instructionContext.sources).toEqual([{ path: 'src/AGENTS.md' }]);
      expect(disclosePaths).toHaveBeenCalledWith('turn', ['src/app.ts']);
    });

    it('returns malformed tool output when the native index rejects a glob pattern', async () => {
      const { root } = await fixture();
      const workspace = new FileSystemWorkspaceTextStore(root);
      const access = new ProjectAccess(root, {}, workspace, {
        glob: async () => {
          throw new WorkspacePathIndexError(
            WorkspacePathIndexFailureReason.INVALID_REQUEST,
            'pattern is not a valid glob',
          );
        },
      });

      const result = JSON.parse(
        await access.execute('list_project_files', JSON.stringify({ glob_pattern: '[', target_directory: null })),
      ) as { error: { code: string; message: string } };

      expect(result.error).toEqual({ code: EditFailureReason.MALFORMED, message: 'pattern is not a valid glob' });
    });

    it('reads bounded line ranges with stable line numbers', async () => {
      const { access } = await fixture();
      const result = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({
            path: 'src/app.ts',
            start_line: 2,
            end_line: 3,
          }),
        ),
      ) as {
        content: string;
        startLine: number;
        endLine: number;
        totalLines: number;
        truncated: boolean;
        revision: string;
        byteOrderMark: boolean;
        lines: { number: number; content: string; lineEnding: string }[];
      };

      expect(result.content).toBe('2: two\n3: three');
      expect(result.startLine).toBe(2);
      expect(result.endLine).toBe(3);
      expect(result.totalLines).toBe(4);
      expect(result.truncated).toBe(true);
      expect(result.revision).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.byteOrderMark).toBe(false);
      expect(result.lines).toEqual([
        { number: 2, content: 'two', lineEnding: '\n' },
        { number: 3, content: 'three', lineEnding: '\n' },
      ]);
    });

    it('accepts project-specific discovery and exclusion limits', async () => {
      const { root } = await fixture();
      const access = new ProjectAccess(root, {
        maxFiles: 1,
        accessPolicy: new WorkspaceAccessPolicy({ sensitiveFilePrefixes: [] }),
      });

      const listed = JSON.parse(
        await access.execute(
          'list_project_files',
          JSON.stringify({ glob_pattern: '**/{*,.*}', target_directory: null }),
        ),
      ) as {
        files: string[];
        truncated: boolean;
      };
      expect(listed).toEqual({ files: ['.env'], truncated: true });
    });

    it('reads an entire large file in one tool call while retaining optional range selection', async () => {
      const { access, root } = await fixture();
      const source = Array.from({ length: 400 }, (_, index) => `line-${index + 1}`).join('\n');
      await writeFile(join(root, 'src', 'large.ts'), source);

      const complete = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({
            path: 'src/large.ts',
            start_line: null,
            end_line: null,
          }),
        ),
      ) as { startLine: number; endLine: number; totalLines: number; truncated: boolean; content: string };
      expect(complete).toMatchObject({ startLine: 1, endLine: 400, totalLines: 400, truncated: false });
      expect(complete.content.split('\n')).toHaveLength(400);
      expect(complete.content).toContain('1: line-1');
      expect(complete.content).toContain('400: line-400');

      const range = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({
            path: 'src/large.ts',
            start_line: 75,
            end_line: 320,
          }),
        ),
      ) as { startLine: number; endLine: number; totalLines: number; truncated: boolean; content: string };
      expect(range).toMatchObject({ startLine: 75, endLine: 320, totalLines: 400, truncated: true });
      expect(range.content.split('\n')).toHaveLength(246);
    });

    it('passes exact file and subtree exclusions through to its workspace adapter', async () => {
      const { root } = await fixture();
      const access = new ProjectAccess(root, { excludedPaths: ['README.md', 'src'] });

      const listed = JSON.parse(
        await access.execute(
          'list_project_files',
          JSON.stringify({ glob_pattern: '**/{*,.*}', target_directory: null }),
        ),
      ) as { files: string[] };
      expect(listed.files).toEqual(['.env.example']);

      const read = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({
            path: 'src/app.ts',
            start_line: null,
            end_line: null,
          }),
        ),
      ) as { error?: { code?: string } };
      expect(read.error?.code).toBe(EditFailureReason.UNSUPPORTED);
    });

    it('rejects malformed glob requests and unsafe or non-directory targets', async () => {
      const { access, root } = await fixture();

      for (const argumentsValue of [
        {},
        { glob_pattern: '', target_directory: null },
        { glob_pattern: '*.ts', target_directory: '..' },
        { glob_pattern: '*.ts', target_directory: root },
        { glob_pattern: '*.ts', target_directory: 'src/app.ts' },
      ]) {
        const result = JSON.parse(await access.execute('list_project_files', JSON.stringify(argumentsValue))) as {
          error?: unknown;
        };
        expect(result.error, JSON.stringify(argumentsValue)).toBeTruthy();
      }
    });

    it('rejects traversal, absolute paths, excluded paths, and symlink escapes', async () => {
      const { access, root } = await fixture();
      const outside = join(root, '..', 'outside-project-file');
      await writeFile(outside, 'secret');
      await symlink(outside, join(root, 'outside-link'));

      for (const path of [
        '../outside-project-file',
        outside,
        'node_modules/dependency.js',
        'target/native-artifact',
        '.env',
        '.git-credentials',
        'outside-link',
      ]) {
        const result = JSON.parse(
          await access.execute(
            'read_project_file',
            JSON.stringify({
              path,
              start_line: null,
              end_line: null,
            }),
          ),
        ) as { error?: string };
        expect(result.error, `${path} should be rejected`).toBeTruthy();
      }
    });

    it('reports an unknown tool as a project access failure', async () => {
      const access = new ProjectAccess(tmpdir());

      const result = JSON.parse(await access.execute('unknown_tool', '{}')) as ProjectOutput;

      expect(result).toEqual({
        error: { code: 'PROJECT_ACCESS_FAILED', message: 'Unknown project tool: unknown_tool' },
      });
    });

    it('reports a failure that is not an error object generically', async () => {
      const access = new ProjectAccess(tmpdir(), {}, undefined, {
        glob: async () => {
          throw 'index crashed';
        },
      });

      const result = JSON.parse(
        await access.execute('list_project_files', JSON.stringify({ glob_pattern: '*', target_directory: null })),
      ) as ProjectOutput;

      expect(result).toEqual({ error: { code: 'PROJECT_ACCESS_FAILED', message: 'Project tool failed.' } });
    });

    it('rethrows the original failure when an aborted signal carries no reason', async () => {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        reason: undefined,
        throwIfAborted: () => {},
      } as unknown as AbortSignal;
      const failure = new Error('listing interrupted');
      const access = new ProjectAccess(tmpdir(), {}, undefined, {
        glob: async () => {
          aborted = true;
          throw failure;
        },
      });

      await expect(
        access.execute('list_project_files', JSON.stringify({ glob_pattern: '*', target_directory: null }), signal),
      ).rejects.toBe(failure);
    });

    it('reports content search as unavailable without a native index', async () => {
      const access = new ProjectAccess(tmpdir());

      const result = JSON.parse(
        await access.execute(
          'search_project_contents',
          JSON.stringify({
            pattern: 'needle',
            pattern_kind: 'literal',
            path: null,
            file_glob: null,
            file_type: null,
            output_mode: 'files_with_matches',
            lines_before: 0,
            lines_after: 0,
            case_sensitive: true,
            multiline: false,
            limit: 10,
            offset: 0,
          }),
        ),
      ) as ProjectOutput;

      expect(result).toEqual({
        error: { code: 'PROJECT_ACCESS_FAILED', message: 'Native project content search is unavailable.' },
      });
    });

    it('searches the whole project when no content-search path is given', async () => {
      const searchContents = vi.fn(async () => ({
        outputMode: 'files_with_matches' as const,
        files: ['src/app.ts'],
        searchedFiles: 1,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: false,
        nextOffset: null,
      }));
      const access = new ProjectAccess(tmpdir(), {}, undefined, {
        glob: async () => ({ files: [], truncated: false }),
        searchContents,
      });

      const result = JSON.parse(
        await access.execute(
          'search_project_contents',
          JSON.stringify({
            pattern: 'needle',
            pattern_kind: 'literal',
            path: null,
            file_glob: null,
            file_type: null,
            output_mode: 'files_with_matches',
            lines_before: 0,
            lines_after: 0,
            case_sensitive: true,
            multiline: false,
            limit: 10,
            offset: 0,
          }),
        ),
      ) as ProjectOutput;

      expect(result.files).toEqual(['src/app.ts']);
      expect(searchContents).toHaveBeenCalledWith('needle', expect.objectContaining({ path: null }));
    });

    it('rejects a snapshot larger than the configured read limit', async () => {
      const workspace = new FileSystemWorkspaceTextStore('/fixture');
      vi.spyOn(workspace, 'read').mockResolvedValue({
        path: 'large.txt',
        text: 'x'.repeat(20),
        byteOrderMark: false,
        mode: 0o644,
        identity: 'fixture',
        revision: 'revision',
        byteLength: 20,
      });
      const access = new ProjectAccess('/fixture', { maxFileBytes: 10 }, workspace);

      const result = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({ path: 'large.txt', start_line: null, end_line: null }),
        ),
      ) as ProjectOutput;

      expect(result).toEqual({
        error: { code: 'PROJECT_ACCESS_FAILED', message: 'File exceeds the 10-byte read limit.' },
      });
    });

    it('rejects a line range that ends before it starts', async () => {
      const { access } = await fixture();

      const result = JSON.parse(
        await access.execute('read_project_file', JSON.stringify({ path: 'src/app.ts', start_line: 3, end_line: 2 })),
      ) as ProjectOutput;

      expect(result.error.message).toBe('end_line must be greater than or equal to start_line.');
    });

    it('rejects a single line that cannot fit in one read result', async () => {
      const workspace = new FileSystemWorkspaceTextStore('/fixture');
      const text = 'x'.repeat(600 * 1024);
      vi.spyOn(workspace, 'read').mockResolvedValue({
        path: 'long-line.txt',
        text,
        byteOrderMark: false,
        mode: 0o644,
        identity: 'fixture',
        revision: 'revision',
        byteLength: text.length,
      });
      const access = new ProjectAccess('/fixture', { maxFileBytes: 1024 * 1024 }, workspace);

      const result = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({ path: 'long-line.txt', start_line: null, end_line: null }),
        ),
      ) as ProjectOutput;

      expect(result.error.message).toBe('This line exceeds the 512 KiB serialized read limit.');
    });

    it('returns an empty page when the requested range starts after the last line', async () => {
      const { access } = await fixture();

      const result = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({ path: 'src/app.ts', start_line: 10, end_line: null }),
        ),
      ) as ProjectOutput;

      expect(result).toMatchObject({
        startLine: 10,
        endLine: 4,
        totalLines: 4,
        truncated: false,
        content: '',
        lines: [],
      });
    });

    it('reports carriage-return and CRLF line endings per line', async () => {
      const { access, root } = await fixture();
      await writeFile(join(root, 'src', 'endings.txt'), 'one\r\ntwo\rthree');

      const result = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({ path: 'src/endings.txt', start_line: null, end_line: null }),
        ),
      ) as ProjectOutput;

      expect(result.lines).toEqual([
        { number: 1, content: 'one', lineEnding: '\r\n' },
        { number: 2, content: 'two', lineEnding: '\r' },
        { number: 3, content: 'three', lineEnding: '' },
      ]);
    });
  });

  describe('tools', () => {
    it('offers listing and reading without a native content index', () => {
      const access = new ProjectAccess(tmpdir());

      expect(access.tools.map(tool => tool.name)).toEqual(['list_project_files', 'read_project_file']);
    });

    it('offers content search with a native content index', () => {
      const access = new ProjectAccess(tmpdir(), {}, undefined, {
        glob: async () => ({ files: [], truncated: false }),
        searchContents: async () => ({
          outputMode: 'count',
          counts: [],
          searchedFiles: 0,
          skippedFiles: 0,
          indexTruncated: false,
          truncated: false,
          nextOffset: null,
        }),
      });

      expect(access.tools.map(tool => tool.name)).toEqual([
        'list_project_files',
        'read_project_file',
        'search_project_contents',
      ]);
    });

    it.each([
      ['list_project_files', { glob_pattern: '*.ts', target_directory: null }, { glob_pattern: '' }],
      ['read_project_file', { path: 'src/app.ts', start_line: null, end_line: null }, { path: 'src/app.ts' }],
      [
        'search_project_contents',
        {
          pattern: 'needle',
          pattern_kind: 'literal',
          path: null,
          file_glob: null,
          file_type: null,
          output_mode: 'content',
          lines_before: 0,
          lines_after: 0,
          case_sensitive: true,
          multiline: false,
          limit: 10,
          offset: 0,
        },
        { pattern: 'needle' },
      ],
    ])('validates %s arguments and executes through project access', async (name, valid, invalid) => {
      const access = new ProjectAccess(tmpdir(), {}, undefined, {
        glob: async () => ({ files: [], truncated: false }),
        searchContents: async () => ({
          outputMode: 'count',
          counts: [],
          searchedFiles: 0,
          skippedFiles: 0,
          indexTruncated: false,
          truncated: false,
          nextOffset: null,
        }),
      });
      const execute = vi.spyOn(access, 'execute').mockResolvedValue('{"ok":true}');
      const tool = access.tools.find(candidate => candidate.name === name)!;
      const signal = new AbortController().signal;

      expect(() => {
        tool.validateInput(JSON.stringify(valid));
      }).not.toThrow();
      expect(() => {
        tool.validateInput(JSON.stringify(invalid));
      }).toThrow();
      await expect(tool.execute(JSON.stringify(valid), signal, {})).resolves.toBe('{"ok":true}');
      expect(execute).toHaveBeenCalledWith(name, JSON.stringify(valid), signal, {});
    });
  });
});
