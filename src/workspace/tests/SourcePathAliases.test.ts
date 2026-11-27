import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { storedSourcePath, readSourcePathAliases } from '../SourcePathAliases.ts';
import { UserStoreProjectRoutes } from '../UserStoreProjectRoutes.ts';

it('resolves prospective names through their actual parent and rejects an inaccessible directory chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'glyph-source-paths-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const root = storedSourcePath(directory);
  const link = join(root, 'link');
  symlinkSync(root, link);
  expect(storedSourcePath(join(link, 'missing', 'child'))).toBe(join(root, 'missing', 'child'));
  writeFileSync(join(root, 'file'), 'file');
  expect(() => storedSourcePath(join(root, 'file', 'child'))).toThrow();
  const platform = vi.spyOn(process, 'platform', 'get');
  try {
    platform.mockReturnValue('darwin');
    expect(readSourcePathAliases('/unused', link)).toEqual([root]);
    platform.mockReturnValue('linux');
    const helper = join(root, 'helper');
    writeFileSync(helper, '#!/bin/sh\ncat >/dev/null\nprintf \'["/mount","/mount"]\'\n', { mode: 0o700 });
    expect(readSourcePathAliases(helper, link, true)).toEqual([root, '/mount']);
  } finally {
    platform.mockRestore();
  }
});

it('owns a mounted store or an individual entry and retains its actual project spelling', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-user-routes-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, 'profile', 'skills');
  mkdirSync(join(store, 'one'), { recursive: true });
  const project = join(root, '.glyph', 'skills');
  mkdirSync(project, { recursive: true });
  const linked = join(project, 'one');
  // An ancestor alias preserves the final inode, as does a bind mount.
  const parentAlias = join(root, 'parentAlias');
  symlinkSync(store, parentAlias);
  const packageAlias = join(parentAlias, 'one');
  const other = join(project, 'other');
  mkdirSync(other);
  const resolver = vi.fn(() => [store, parentAlias, packageAlias, other]);
  const routes = new UserStoreProjectRoutes(store, true, resolver);
  routes.refresh();
  expect(routes.ownsEntry(join(store, 'one'))).toBe(true);
  expect(routes.ownsEntry(other)).toBe(false);
  expect(routes.ownsEntry(linked)).toBe(false);
  expect(routes.projectEntries('one')).toContain(packageAlias);
  expect(routes.projectMarker(linked)).toBe('.glyph');
  expect(routes.projectMarker(join(root, '.cursor', 'different', 'item'))).toBeUndefined();
  expect(routes.projectMarker(join(root, 'custom', 'skills', 'item'))).toBeUndefined();
  expect(resolver).toHaveBeenCalledTimes(1);
});
