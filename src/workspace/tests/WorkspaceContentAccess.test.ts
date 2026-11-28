import { mkdtemp, mkdir, writeFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, onTestFinished } from 'vitest';
import { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceContentAccess } from '#src/workspace/policy/WorkspaceContentAccess.js';
import { WorkspaceRootAccess } from '#src/workspace/policy/WorkspaceRootAccess.js';
import { StartupUserProfile } from '#src/workspace/policy/StartupUserProfile.js';

describe(WorkspaceContentAccess, () => {
  it('admits a selected personal file for one attachment while project reads and search keep their own scope', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-content-access-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    using profile = new StartupUserProfile(join(root, 'personal'));
    const state = join(root, 'personal/state.json');
    for (const file of [
      'personal/rules/selected.mdc',
      'personal/skills/editor/SKILL.md',
      'personal/state.json',
      'other/.glyph/rules/local.mdc',
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), 'body');
    }
    let privatePaths = [state];
    const policy = new WorkspaceContentAccess(profile, () => privatePaths, [], [root]);
    expect(policy.shell.privatePaths).toEqual(expect.arrayContaining([profile.path, join(root, '.skill-staging')]));
    const binaryPath = resolve('target/release/glyph-context-index');
    const physicalAccess = new NativeFilesystemMetadata(binaryPath);
    const access = new WorkspaceRootAccess(policy.project, root, true);
    const project = new FileSystemWorkspaceTextStore(root, { access, physicalAccess });
    const selected = new FileSystemWorkspaceTextStore(root, {
      access: new WorkspaceRootAccess(policy.selectedFile, root, true),
      physicalAccess,
    });
    expect(await project.canonicalPath('other/NewSource.mdc')).toBe(join(root, 'other/NewSource.mdc'));
    const attachments = new ContextAttachmentService(selected);
    const index = new RustWorkspacePathIndex({ access, binaryPath });
    onTestFinished(() => index.dispose());
    expect((await attachments.resolve([{ path: 'personal/rules/selected.mdc' }]))[0]?.text).toBe('body');
    await expect(attachments.resolve([{ path: 'personal/state.json' }])).rejects.toThrow();
    await expect(project.read('personal/rules/selected.mdc')).rejects.toThrow('excluded');
    expect(await index.glob('**/*', { limit: 20 })).toEqual({
      files: ['other/.glyph/rules/local.mdc'],
      truncated: false,
    });
    const pending = [policy.project, policy.shell, policy.selectedFile, policy.userCatalog].map(view =>
      view.beginOperation(),
    );
    await rename(profile.path, join(root, 'relocated'));
    await expect(project.read('relocated/rules/selected.mdc')).rejects.toThrow('user profile');
    await expect(selected.read('relocated/state.json')).rejects.toThrow('user profile');
    await expect(attachments.resolve([{ path: 'relocated/state.json' }])).rejects.toThrow();
    await expect(index.glob('**/*', { limit: 20 })).rejects.toThrow('user profile');
    await mkdir(profile.path);
    expect(() => policy.shell.beginOperation()).toThrow('user profile');
    await rm(profile.path, { recursive: true });
    await rename(join(root, 'relocated'), profile.path);
    for (const operation of pending) expect(operation.assertCurrent).toThrow('Workspace access changed');
    expect(await project.read('other/.glyph/rules/local.mdc')).toHaveProperty('text', 'body');
    await expect(project.read('personal/rules/selected.mdc')).rejects.toThrow('excluded');
    expect((await attachments.resolve([{ path: 'personal/rules/selected.mdc' }]))[0]?.text).toBe('body');
    expect((await index.glob('**/*', { limit: 20 })).files).toEqual(['other/.glyph/rules/local.mdc']);
    privatePaths = [state, join(root, 'other')];
    await expect(project.read('other/.glyph/rules/local.mdc')).rejects.toThrow('excluded');
    expect(await index.glob('**/*', { limit: 20 })).toEqual({ files: [], truncated: false });
    expect(() => new FileSystemWorkspaceTextStore(join(root, 'other'), { access, physicalAccess })).toThrow(
      'different root',
    );
    const source = new NativeFilesystemMetadata(binaryPath);
    expect(await source.sourceOrigins([], [])).toEqual([]);
    await expect(source.sourceOrigins([state], privatePaths)).rejects.toThrow();
  });
});
