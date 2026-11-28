import { fstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LocalSkillSourceAuthority } from '#src/skills/LocalSkillSourceAuthority.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

async function source() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'glyph-approved-source-')));
  onTestFinished(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'selected');
  const file = join(root, 'SKILL.md');
  await mkdir(root);
  await writeFile(file, 'Reviewed contents');
  const origins = vi.fn(testFilesystemMetadata.sourceOrigins);
  const unlinked = vi.fn(async (_descriptor: number) => {});
  const metadata = { sourceOrigins: origins, assertUnlinkedDirectory: unlinked };
  const dirs = await origins([parent, root], [], undefined, true);
  const identity = (await origins([file], []))[0]!.identity;
  const reads = new Map([[file, identity]]);
  const capture = () =>
    LocalSkillSourceAuthority.capture(metadata, new WorkspaceAccessPolicy(), root, dirs, reads, async () => {});
  return { parent, root, file, origins, unlinked, dirs, reads, capture };
}

describe(LocalSkillSourceAuthority, () => {
  it('admits only the files that supplied the captured bytes', async () => {
    const fixture = await source();
    fixture.reads.set(fixture.file, 'changed');
    await expect(fixture.capture()).rejects.toThrow('location changed');
  });

  it('rejects a root that disappears before a preview is retained', async () => {
    const fixture = await source();
    const captured = await fixture.capture();
    await rm(fixture.root, { recursive: true });
    await expect(captured.retain()).rejects.toThrow('location changed');
    expect(fixture.unlinked).not.toHaveBeenCalled();
  });

  it('rejects a newly opened directory that disagrees with the inspected identity', async () => {
    const fixture = await source();
    fixture.dirs[1] = { ...fixture.dirs[1]!, identity: 'changed' };
    await expect((await fixture.capture()).retain()).rejects.toThrow('location changed');
  });

  it('rechecks each live resource origin and both selected directory routes', async () => {
    const fixture = await source();
    const receipt = await (await fixture.capture()).retain();
    onTestFinished(receipt.release);
    await expect(receipt.assertCurrent()).resolves.toBeUndefined();
    fixture.origins.mockResolvedValueOnce(fixture.dirs).mockResolvedValueOnce([{ origin: 'rebound', identity: '1:2' }]);
    await expect(receipt.assertCurrent()).rejects.toThrow('location changed');
    fixture.origins.mockResolvedValueOnce(fixture.dirs.toReversed());
    await expect(receipt.assertCurrent()).rejects.toThrow('location changed');
  });

  it('rechecks the parent and the missing name after confirming a deleted selection', async () => {
    const fixture = await source();
    const receipt = await (await fixture.capture()).retain();
    await rm(fixture.root, { recursive: true });
    await expect(receipt.assertCurrent()).resolves.toBeUndefined();
    const descriptor = fixture.unlinked.mock.calls[0]![0];
    expect(fstatSync(descriptor).isDirectory()).toBe(true);
    fixture.origins.mockResolvedValueOnce([{ origin: 'changed', identity: '1:4' }]);
    await expect(receipt.assertCurrent()).rejects.toThrow('location changed');
    fixture.origins.mockImplementationOnce(async () => {
      await mkdir(fixture.root);
      return [fixture.dirs[0]!];
    });
    await expect(receipt.assertCurrent()).rejects.toThrow('location changed');
    receipt.release();
    expect(() => fstatSync(descriptor)).toThrow(/EBADF/u);
  });

  it('verifies the reviewed object in an in-place transaction backup', async () => {
    const fixture = await source();
    const receipt = await (await fixture.capture()).retain();
    onTestFinished(receipt.release);
    const backup = join(fixture.parent, 'backup');
    const move = { source: fixture.root, backup };
    await mkdir(backup);
    await expect(receipt.assertCurrent(move)).rejects.toThrow('location changed');
    await rm(backup, { recursive: true });
    await rename(fixture.root, backup);
    expect((await stat(backup)).isDirectory()).toBe(true);
    await expect(receipt.assertCurrent(move)).resolves.toBeUndefined();
    fixture.origins.mockResolvedValueOnce([{ origin: 'changed', identity: '1:4' }]);
    await expect(receipt.assertCurrent(move)).rejects.toThrow('location changed');
  });
});
