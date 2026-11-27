import { mkdir, mkdtemp, writeFile, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, onTestFinished } from 'vitest';
import { installedPackageModes } from '../installedPackageModes.ts';

it('compares changes against the inventoried destination and fails closed if an occupant is new or unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-installed-modes-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = { mode: 0o600, bytes: Uint8Array.of(5), revision: 'original' };
  const before = {
    files: new Map([
      ['stored', file],
      ['vanished', file],
    ]),
    directories: new Map([['restricted', 0o700]]),
  };
  await writeFile(join(root, 'stored'), 'old');
  await link(join(root, 'stored'), join(root, 'installed-alias'));
  await mkdir(join(root, 'restricted'));
  await symlink(root, join(root, 'route'));
  const modes = await installedPackageModes(
    root,
    ['stored', 'restricted', 'missing', 'stored/child', 'installed-alias', 'route/restricted'],
    before,
  );
  expect(modes.files.get('installed-alias')).toEqual(file);
  expect(modes.directories.get('route/restricted')).toBe(0o700);
  expect(modes.files.has('missing')).toBe(false);
  await writeFile(join(root, 'appeared'), 'independent');
  await expect(installedPackageModes(root, ['appeared'], before)).rejects.toThrow('changed while comparing');
  await expect(installedPackageModes(root, ['invalid\0name'], before)).rejects.toThrow();
  expect(await installedPackageModes(root, ['new'], { files: new Map(), directories: new Map() })).toMatchObject({
    files: new Map(),
  });
});
