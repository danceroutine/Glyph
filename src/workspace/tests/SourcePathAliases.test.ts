import fs from 'node:fs';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { storedSourcePath, readSourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { UserStoreProjectRoutes } from '#src/workspace/UserStoreProjectRoutes.js';

it('resolves prospective names through their actual parent and rejects an inaccessible directory chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'glyph-source-paths-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
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
    writeFileSync(helper, '#!/bin/sh\ncat > "$0.request"\nprintf \'["/mount","/mount"]\'\n', { mode: 0o700 });
    expect(readSourcePathAliases(helper, link, true)).toEqual([root, '/mount']);
    const prospective = join(root, 'new', 'SKILL.md');
    expect(readSourcePathAliases(helper, [link, join(link, 'new', 'SKILL.md')])).toEqual([root, prospective, '/mount']);
    expect(JSON.parse(readFileSync(helper + '.request', 'utf8'))).toEqual([[root, prospective], false]);
  } finally {
    platform.mockRestore();
  }
});

it('reserves a confirmed cycle of absolute and relative links and retries a repaired personal store', () => {
  const root = storedSourcePath(mkdtempSync(join(tmpdir(), 'glyph-cyclic-store-')));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const store = join(root, 'rules');
  const alternate = join(root, 'alternate');
  symlinkSync(alternate, store);
  symlinkSync('rules', alternate);
  expect(storedSourcePath(store)).toBe(store);
  const routes = new UserStoreProjectRoutes(store, true);
  expect(routes.ownsEntry(join(root, 'project', 'one.mdc'))).toBe(false);
  rmSync(store);
  mkdirSync(store);
  routes.refresh();
  expect(storedSourcePath(alternate)).toBe(store);
  expect(routes.projectEntries('one.mdc')).toEqual([join(store, 'one.mdc')]);
});

it('keeps an unresolved chain unavailable when inspection cannot prove a cycle', () => {
  const root = storedSourcePath(mkdtempSync(join(tmpdir(), 'glyph-long-store-')));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 130; i++) symlinkSync(String(i + 1), join(root, String(i)));
  mkdirSync(join(root, '130'));
  expect(() => storedSourcePath(join(root, '0'))).toThrow();
});

it('keeps an alias inspection failure local to the current discovery pass', () => {
  const lookup = vi
    .fn<() => string[]>()
    .mockImplementationOnce(() => {
      throw new Error('Cannot inspect mounts');
    })
    .mockReturnValue([]);
  const routes = new UserStoreProjectRoutes('/profile/rules', true, lookup);
  routes.refresh();
  expect(() => routes.ownsEntry('/project/.glyph/rules/one.mdc')).toThrow('Cannot inspect mounts');
  expect(() => routes.projectEntries('one.mdc')).toThrow('Cannot inspect mounts');
  expect(lookup).toHaveBeenCalledTimes(1);
  routes.refresh();
  expect(routes.ownsEntry('/project/.glyph/rules/one.mdc')).toBe(false);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('owns a mounted store or an individual entry and retains its actual project spelling', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-user-routes-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
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

it('indexes individual mounted entries once and rechecks identity after a source or projected name changes', async () => {
  const { linkSync, renameSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'glyph-mounted-entry-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const directory = join(root, 'rules');
  mkdirSync(directory);
  const user = join(directory, 'a.mdc');
  const outside = join(root, 'published.mdc');
  const second = join(root, 'other-name');
  const missing = join(root, 'missing');
  writeFileSync(user, 'rule');
  linkSync(user, outside);
  linkSync(user, second);
  writeFileSync(join(directory, 'unmounted.mdc'), 'unmounted');
  const resolver = vi.fn(() => [directory, outside, second, missing]);
  const lookup = new UserStoreProjectRoutes(directory, true, resolver);
  const list = fs.readdirSync.bind(fs);
  const read = vi
    .spyOn(fs, 'readdirSync')
    .mockImplementationOnce(((path: string) => [
      ...list(path),
      'removed-between-list-and-stat',
    ]) as typeof fs.readdirSync);
  onTestFinished(() => {
    read.mockRestore();
  });
  expect(lookup.ownsEntry(outside)).toBe(true);
  expect(lookup.ownsEntry(second)).toBe(true);
  expect(lookup.projectEntries('a.mdc')).toEqual([user, outside, second]);
  expect(lookup.projectEntries('unmounted.mdc')).toEqual([join(directory, 'unmounted.mdc')]);
  expect(lookup.projectEntries('missing.mdc')).toEqual([join(directory, 'missing.mdc')]);
  expect(lookup.ownsEntry(missing)).toBe(false);
  renameSync(outside, missing);
  writeFileSync(outside, 'different');
  expect(lookup.projectEntries('a.mdc')).toEqual([user, second]);
  expect(lookup.ownsEntry(outside)).toBe(false);
  renameSync(user, join(root, 'old-source'));
  writeFileSync(user, 'changed');
  expect(lookup.ownsEntry(second)).toBe(false);
  expect(resolver).toHaveBeenCalledTimes(1);
  lookup.refresh();
  expect(lookup.ownsEntry(second)).toBe(false);
  expect(resolver).toHaveBeenCalledTimes(2);
});

it('rejects a previously equivalent store route after an editor alias is rebound', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-user-rebound-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const a = join(root, 'original');
  const b = join(root, 'other');
  const logical = join(root, 'editor');
  for (const parent of [a, b]) {
    mkdirSync(join(parent, 'rules'), { recursive: true });
    writeFileSync(join(parent, 'rules', 'one.mdc'), parent);
  }
  symlinkSync(a, logical);
  const store = join(a, 'rules');
  const alias = join(logical, 'rules');
  const lookup = new UserStoreProjectRoutes(store, true, () => [store, alias]);
  lookup.refresh();
  expect(lookup.projectEntries('one.mdc')).toEqual([join(store, 'one.mdc'), join(alias, 'one.mdc')]);
  rmSync(logical);
  symlinkSync(b, logical);
  expect(lookup.projectEntries('one.mdc')).toEqual([join(store, 'one.mdc')]);
});
