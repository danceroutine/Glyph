import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectAccess } from '../ProjectAccess.ts';

async function fixture(): Promise<{ access: ProjectAccess; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'harness-chat-project-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'README.md'), '# Sample\n');
  await writeFile(join(root, '.env'), 'SECRET=hidden');
  await writeFile(join(root, '.env.example'), 'SECRET=');
  await writeFile(join(root, 'src', 'app.ts'), ['one', 'two', 'three', 'four'].join('\n'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored');
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
  const result = JSON.parse(await access.execute('read_project_file', JSON.stringify({
    path: 'src/app.ts', start_line: 2, end_line: 3,
  }))) as { content: string; startLine: number; endLine: number; totalLines: number; truncated: boolean };

  expect(result.content).toBe('2: two\n3: three');
  expect(result.startLine).toBe(2);
  expect(result.endLine).toBe(3);
  expect(result.totalLines).toBe(4);
  expect(result.truncated).toBe(true);
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

  const read = JSON.parse(await access.execute('read_project_file', JSON.stringify({
    path: 'src/app.ts', start_line: 1, end_line: 2,
  }))) as { error?: string };
  expect(read.error ?? '').toMatch(/at most 1 lines/);
});

it('rejects traversal, absolute paths, excluded paths, and symlink escapes', async () => {
  const { access, root } = await fixture();
  const outside = join(root, '..', 'outside-project-file');
  await writeFile(outside, 'secret');
  await symlink(outside, join(root, 'outside-link'));

  for (const path of ['../outside-project-file', outside, 'node_modules/dependency.js', '.env', 'outside-link']) {
    const result = JSON.parse(await access.execute('read_project_file', JSON.stringify({
      path, start_line: null, end_line: null,
    }))) as { error?: string };
    expect(result.error, `${path} should be rejected`).toBeTruthy();
  }
});
});
});
