import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditFailureReason } from '../../editing/errors/EditFailureReason.ts';
import { ProjectAccess } from '../ProjectAccess.ts';

async function fixture(): Promise<{ access: ProjectAccess; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'harness-chat-project-'));
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
    it('lists project files while excluding generated and dependency directories', async () => {
      const { access, root } = await fixture();
      await symlink(join(root, 'README.md'), join(root, 'linked-readme'));

      const result = JSON.parse(await access.execute('list_project_files', '{}')) as {
        files: string[];
        truncated: boolean;
      };
      expect(result).toEqual({ files: ['.env.example', 'README.md', 'src/app.ts'], truncated: false });
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

    it('accepts project-specific discovery, read, and exclusion limits', async () => {
      const { root } = await fixture();
      const access = new ProjectAccess(root, {
        maxFiles: 1,
        maxLinesPerRead: 1,
        sensitiveFilePrefixes: [],
      });

      const listed = JSON.parse(await access.execute('list_project_files', '{}')) as {
        files: string[];
        truncated: boolean;
      };
      expect(listed).toEqual({ files: ['.env'], truncated: true });

      const read = JSON.parse(
        await access.execute(
          'read_project_file',
          JSON.stringify({
            path: 'src/app.ts',
            start_line: 1,
            end_line: 2,
          }),
        ),
      ) as { error?: { message?: string } };
      expect(read.error?.message ?? '').toMatch(/at most 1 lines/);
    });

    it('passes exact file and subtree exclusions through to its workspace adapter', async () => {
      const { root } = await fixture();
      const access = new ProjectAccess(root, { excludedPaths: ['README.md', 'src'] });

      const listed = JSON.parse(await access.execute('list_project_files', '{}')) as { files: string[] };
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
