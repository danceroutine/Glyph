import { appendFile, chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { readHostFile } from '../readHostFile.ts';
import { SkillPreferenceFile } from '../SkillPreferenceFile.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-host-file-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = new SkillPreferenceFile(root, testFilesystemMetadata);
  await writeFile(file.path, 'first', { mode: 0o600 });
  const stage = join(root, '.skill-staging');
  await mkdir(stage, { mode: 0o700 });
  return { file, root, stage };
}

describe(SkillPreferenceFile, () => {
  it('preserves the original when staging cannot reproduce the recorded group or authorization becomes stale', async () => {
    const { file, stage } = await fixture();
    const previous = (await file.read())!;
    await expect(
      file.replace({ ...previous, gid: previous.gid + 1 }, 'new', stage, async () => {}, undefined),
    ).rejects.toThrow('ownership');
    await expect(file.replace(previous, 'new', stage, () => chmod(file.path, 0o400), undefined)).rejects.toThrow(
      'changed',
    );
    await expect(readFile(file.path, 'utf8')).resolves.toBe('first');
    await expect(file.replace(previous, 'new', stage, () => rm(file.path), undefined)).rejects.toThrow('changed');
  });
});

describe(readHostFile, () => {
  it('rejects linked host files and physical ancestors that became symbolic aliases', async () => {
    const { file, root } = await fixture();
    await symlink(root, join(root, 'alias'));
    await expect(readHostFile(join(root, 'alias/skill-state.json'))).rejects.toThrow('physical');
    await link(file.path, join(root, 'linked'));
    await expect(readHostFile(file.path)).rejects.toThrow('link');
  });

  it('bounds bytes before allocating and checks the selected file did not grow while it was read', async () => {
    const { file } = await fixture();
    await expect(readHostFile(file.path, 2)).rejects.toThrow('budget');
    await expect(
      readHostFile(file.path, 5, async handle => {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
          await appendFile(file.path, 'extra');
          return read(...args);
        });
      }),
    ).rejects.toThrow('changed');
  });
});
