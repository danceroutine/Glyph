import { testPackageMutations } from './fixtures/testPackageMutations.ts';
import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-preferences-authority-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'skill-state.json');
  await writeFile(path, JSON.stringify({ enabled: { example: false }, installations: {} }), { mode: 0o600 });
  const state = new SkillStateStore(root, testFilesystemMetadata, testPackageMutations);
  return { root, path, state };
}

describe(SkillStateStore, () => {
  it.each([true, false])(
    'preserves preference state when the window is revoked during staging, existing file %s',
    async existing => {
      const { root, path } = await fixture();
      if (!existing) await rm(path);
      const owner = new AbortController();
      const metadata = {
        ...testFilesystemMetadata,
        inspect: async (...args: Parameters<typeof testFilesystemMetadata.inspect>) => {
          // The private temporary file contains the proposed preference after the lock is acquired.
          const handle = args[0];
          const data = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(data, 0, data.length, 0).catch(() => ({ bytesRead: 0 }));
          if (data.subarray(0, bytesRead).toString().includes('"example": true'))
            owner.abort(new Error('Window revoked'));
          await testFilesystemMetadata.inspect(...args);
        },
      };
      const state = new SkillStateStore(root, metadata, testPackageMutations);
      await expect(state.setEnabled('example', true, owner.signal)).rejects.toThrow('Window revoked');
      if (existing) expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: { example: false } });
      else await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('reconciles a committed toggle when the window closes before a failed rename acknowledgement', async () => {
    const { path, state } = await fixture();
    await state.initialize();
    const owner = new AbortController();
    const replace = state.preferences.replace.bind(state.preferences);
    vi.spyOn(state.preferences, 'replace').mockImplementationOnce(async (...args) => {
      await replace(...args);
      owner.abort(new Error('Window closed'));
      throw new Error('Rename acknowledgement lost');
    });

    await state.setEnabled('example', true, owner.signal);
    expect(state.enabled.get('example')).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: { example: true } });
  });

  it('retains owner-controlled traversable profiles but refuses foreign-writable profiles before creating locks', async () => {
    const { root, state } = await fixture();
    await chmod(root, 0o755);
    await state.initialize();
    expect(state.enabled.get('example')).toBe(false);
    for (const mode of [0o775, 0o777]) {
      await chmod(root, mode);
      await expect(state.initialize()).rejects.toThrow('profile');
      await expect(state.setEnabled('example', true, new AbortController().signal)).rejects.toThrow('profile');
      expect(state.enabled.get('example')).toBe(false);
    }
    await chmod(root, 0o700);
    await state.setEnabled('example', true, new AbortController().signal);
    expect(state.enabled.get('example')).toBe(true);
  });

  it('refuses group-writable and world-writable preference bytes without changing current enablement', async () => {
    const { path, state } = await fixture();
    await state.initialize();
    for (const mode of [0o660, 0o666]) {
      await chmod(path, mode);
      await expect(state.initialize()).rejects.toThrow('preferences');
      await expect(state.setEnabled('example', true, new AbortController().signal)).rejects.toThrow('preferences');
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
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: { example: false } });
  });

  it('rejects a foreign-owned preference file inside an admitted owner-controlled directory', async () => {
    const { root, path } = await fixture();
    const disk = fixtureWorkspace(root);
    const state = new SkillStateStore(disk.root, testFilesystemMetadata, testPackageMutations);
    await state.initialize();
    const uid = (await stat(path)).uid;
    const readOptional = state.preferences.read.bind(state.preferences);
    vi.spyOn(state.preferences, 'read').mockImplementation(async (...args) => {
      const current = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        return await readOptional(...args);
      } finally {
        current.mockRestore();
      }
    });
    await expect(state.initialize()).rejects.toThrow('Skill preferences must belong');
    await expect(state.setEnabled('example', true, new AbortController().signal)).rejects.toThrow(
      'Skill preferences must belong',
    );
    expect(state.enabled.get('example')).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: { example: false } });
  });

  it('reopens and updates a valid preference store after its saved representation grows beyond one MiB', async () => {
    const { path, state } = await fixture();
    const prefix = 'project:1234567890abcdef:.glyph:.glyph/skills/';
    const enabled = Object.fromEntries(Array.from({ length: 6900 }, (_, i) => [prefix + 'a'.repeat(88) + i, false]));
    await writeFile(path, JSON.stringify({ enabled, installations: {} }));
    expect((await stat(path)).size).toBeLessThan(1024 * 1024);
    await state.setEnabled('example', true, new AbortController().signal);
    expect((await stat(path)).size).toBeGreaterThan(1024 * 1024);
    await state.initialize();
    await state.setEnabled('example', false, new AbortController().signal);
    expect(state.enabled.get('example')).toBe(false);
    expect(state.enabled.size).toBe(6901);
  });

  it('checks the opened preference inode before consuming bytes and rejects permission changes during a read', async () => {
    const { root, path } = await fixture();
    const inode = (await stat(path)).ino;
    const metadata = {
      inspect: vi.fn(async (handle: import('node:fs/promises').FileHandle) => {
        if ((await handle.stat()).ino === inode) await handle.chmod(0o666);
      }),
    };
    const state = new SkillStateStore(root, metadata, testPackageMutations);
    await expect(state.initialize()).rejects.toThrow('preferences');
    expect(state.enabled.size).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o666);
  });
});
