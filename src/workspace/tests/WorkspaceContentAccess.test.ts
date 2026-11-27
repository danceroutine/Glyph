import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, onTestFinished } from 'vitest';
import { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { NativeFilesystemMetadata } from '../NativeFilesystemMetadata.ts';
import { FileSystemWorkspaceTextStore } from '../FileSystemWorkspaceTextStore.ts';
import { WorkspaceContentAccess } from '../policy/WorkspaceContentAccess.ts';
import { WorkspaceRootAccess } from '../policy/WorkspaceRootAccess.ts';
import { StartupUserProfile } from '../policy/StartupUserProfile.ts';

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
    const policy = new WorkspaceContentAccess(profile, () => privatePaths, []);
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
