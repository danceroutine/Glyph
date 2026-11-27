import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

describe(HostExecutionAuthority, () => {
  it('rechecks admitted configuration and helpers when another window attaches their directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'glyph-repository-authority-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const project = join(base, 'project');
    const config = join(base, 'dotfiles');
    await mkdir(project);
    await mkdir(config);
    const path = join(config, 'git.config');
    await writeFile(path, '');
    let roots = [project];
    const authority = new HostExecutionAuthority(() => roots, testFilesystemMetadata);
    authority.admit(path);
    expect(authority.executable('git')).toContain('git');
    await expect(authority.validate()).resolves.toBeUndefined();
    roots = [project, config];
    await expect(authority.validate()).rejects.toThrow('outside writable workspaces');
    expect(() => new HostExecutionAuthority([config], testFilesystemMetadata).admit(path)).toThrow(
      'outside writable workspaces',
    );
  });

  it('tracks a logical helper alias as well as its original target', async () => {
    const base = await mkdtemp(join(tmpdir(), 'glyph-repository-alias-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const project = join(base, 'project');
    await mkdir(project);
    const trusted = join(base, 'trusted');
    const controlled = join(project, 'controlled');
    await writeFile(trusted, '');
    await writeFile(controlled, '');
    const alias = join(base, 'helper');
    await symlink(trusted, alias);
    const authority = new HostExecutionAuthority([project], testFilesystemMetadata);
    authority.admit(alias);
    await rm(alias);
    await symlink(controlled, alias);
    await expect(authority.validate()).rejects.toThrow('outside writable workspaces');
  });

  it('rejects root changes during native validation and propagates a physical alias rejection', async () => {
    const roots: string[] = [];
    const authority = new HostExecutionAuthority(() => roots, {
      assertHostPaths: async () => {
        roots.push('new-workspace');
      },
    });
    await expect(authority.validate()).rejects.toThrow('workspace authority changed');
    await expect(
      new HostExecutionAuthority([], {
        assertHostPaths: async () => {
          throw new Error('Bound configuration alias');
        },
      }).validate(),
    ).rejects.toThrow('Bound configuration alias');
  });
});
