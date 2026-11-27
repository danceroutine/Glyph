import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-preferences-authority-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'skill-state.json');
  await writeFile(path, JSON.stringify({ enabled: { example: false }, installations: {} }), { mode: 0o600 });
  const state = new SkillStateStore(new FileSystemWorkspaceTextStore(root), testFilesystemMetadata);
  return { root, path, state };
}

describe(SkillStateStore, () => {
  it('retains owner-controlled traversable profiles but refuses foreign-writable profiles before creating locks', async () => {
    const { root, state } = await fixture();
    await chmod(root, 0o755);
    await state.initialize();
    expect(state.enabled.get('example')).toBe(false);
    for (const mode of [0o775, 0o777]) {
      await chmod(root, mode);
      await expect(state.initialize()).rejects.toThrow('profile');
      await expect(state.setEnabled('example', true)).rejects.toThrow('profile');
      expect(state.enabled.get('example')).toBe(false);
    }
    await chmod(root, 0o700);
    await state.setEnabled('example', true);
    expect(state.enabled.get('example')).toBe(true);
  });

  it('refuses group-writable, world-writable and foreign-owned preference bytes without changing current enablement', async () => {
    const { path, state } = await fixture();
    await state.initialize();
    for (const mode of [0o660, 0o666]) {
      await chmod(path, mode);
      await expect(state.initialize()).rejects.toThrow('preferences');
      await expect(state.setEnabled('example', true)).rejects.toThrow('preferences');
      expect(state.enabled.get('example')).toBe(false);
    }
    await chmod(path, 0o600);
    const uid = (await stat(path)).uid;
    const current = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      await expect(state.initialize()).rejects.toThrow('profile');
    } finally {
      current.mockRestore();
    }
    expect(JSON.parse(await readFile(path, 'utf8')).enabled.example).toBe(false);
  });

  it('checks the opened preference inode before consuming bytes and rejects permission changes during a read', async () => {
    const { root, path } = await fixture();
    const inode = (await stat(path)).ino;
    const metadata = {
      inspect: vi.fn(async (handle: import('node:fs/promises').FileHandle) => {
        if ((await handle.stat()).ino === inode) await handle.chmod(0o666);
      }),
    };
    const state = new SkillStateStore(new FileSystemWorkspaceTextStore(root), metadata);
    await expect(state.initialize()).rejects.toThrow('preferences');
    expect(state.enabled.size).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o666);
  });
});
