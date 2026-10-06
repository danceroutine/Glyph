import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePathIndexError } from '../../context/search/WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from '../../context/search/WorkspacePathIndexFailureReason.ts';
import { EditFailureReason } from '../../editing/errors/EditFailureReason.ts';
import { FileSystemWorkspaceTextStore } from '../../workspace/FileSystemWorkspaceTextStore.ts';
import { ProjectAccess } from '../ProjectAccess.ts';

async function fixture(): Promise<{ access: ProjectAccess; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-project-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'README.md'), '# Sample\n');
  await writeFile(join(root, '.env'), 'SECRET=hidden');
  await writeFile(join(root, '.env.example'), 'SECRET=');
  await writeFile(join(root, 'src', 'app.ts'), ['one', 'two', 'three', 'four'].join('\n'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored');
  await writeFile(join(root, 'target', 'native-artifact'), 'ignored');
  return { access: new ProjectAccess(root), root };
}

describe(ProjectAccess, () => {
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
      );

      expect(result).toEqual({ files: ['src/app.ts'], truncated: false });
      expect(glob).toHaveBeenCalledWith('*.ts', { targetDirectory: 'src', limit: 37 });
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
      expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
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
        sensitiveFilePrefixes: [],
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
  });
});
