import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeLeakedCodeOssHuskyHooks } from '#scripts/code-oss/git-hooks.mjs';

/** @type {string[]} */
const repositories = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repository => rm(repository, { recursive: true, force: true })));
});

describe('generated Code OSS Git hooks', () => {
  it('removes leaked upstream Husky hooks without touching user-owned hooks', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'glyph-code-oss-hooks-'));
    repositories.push(repository);
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    const hooks = join(repository, '.git', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\n#husky 0.13.4\n\ncd .code-oss/src\n\nnpm run -s precommit\n',
    );
    await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\necho user-owned hook\n');

    await expect(removeLeakedCodeOssHuskyHooks(repository)).resolves.toEqual(['pre-commit']);
    await expect(access(join(hooks, 'pre-commit'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(hooks, 'pre-push'), 'utf8')).resolves.toContain('user-owned hook');
  });

  it('reports nothing when the repository has no hooks directory', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'glyph-code-oss-hooks-'));
    repositories.push(repository);
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    await rm(join(repository, '.git', 'hooks'), { recursive: true, force: true });

    await expect(removeLeakedCodeOssHuskyHooks(repository)).resolves.toEqual([]);
  });

  it('skips nested directories inside the hooks directory', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'glyph-code-oss-hooks-'));
    repositories.push(repository);
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    await mkdir(join(repository, '.git', 'hooks', 'husky'), { recursive: true });

    await expect(removeLeakedCodeOssHuskyHooks(repository)).resolves.toEqual([]);
  });

  it('propagates failures to read a hooks path that is not a directory', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'glyph-code-oss-hooks-'));
    repositories.push(repository);
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    await rm(join(repository, '.git', 'hooks'), { recursive: true, force: true });
    await writeFile(join(repository, '.git', 'hooks'), 'not a directory');

    await expect(removeLeakedCodeOssHuskyHooks(repository)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
