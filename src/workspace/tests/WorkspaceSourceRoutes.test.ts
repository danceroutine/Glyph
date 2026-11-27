import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { matchesAgentRulePath } from '#src/instructions/rules/matchesAgentRulePath.js';
import {
  type AgentInstructionSource,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
} from '#src/instructions/AgentInstructionSource.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';

it('keeps logical aliases and selects the most specific indexed route for each physical file', () => {
  const outer = { name: 'Outer', path: '/work' };
  const inner = { name: 'Inner', path: '/work/sub' };
  const alias = { name: 'Alias', path: '/work/sub' };
  const routes = new WorkspaceSourceRoutes([outer, inner, alias]);
  expect(routes.equivalents('Outer/sub')).toEqual(['Inner', 'Alias', 'Outer/sub']);
  expect(routes.physicalPath('Alias/AGENTS.md')).toBe('/work/sub/AGENTS.md');
  expect(routes.legacyPaths('Inner/A')).toEqual(['Inner/A', 'A', 'Alias/A', 'Outer/sub/A', 'sub/A']);
  expect(
    routes.uniqueFiles([
      'Alias/AGENTS.md',
      'Outer/sub/AGENTS.md',
      'Inner/AGENTS.md',
      'Outer/sub/nested/AGENTS.md',
      'Outer/AGENTS.md',
    ]),
  ).toEqual(['Inner/AGENTS.md', 'Outer/sub/nested/AGENTS.md', 'Outer/AGENTS.md']);
  expect(new WorkspaceSourceRoutes([outer, { ...inner, caseSensitive: false }]).equivalents('Outer/SUB/file')).toEqual([
    'Inner/file',
    'Outer/SUB/file',
  ]);
  expect(
    new WorkspaceSourceRoutes([
      { ...outer, uri: 'file:///Alias%20Repo' },
      { ...inner, uri: 'file:///alias-inner', caseSensitive: false },
    ]).referenceResources('Outer/sub/a#b.md'),
  ).toEqual([
    { uri: 'file:///work/sub/a%23b.md', caseSensitive: true },
    { uri: 'file:///alias-inner/a%23b.md', caseSensitive: false },
    { uri: 'file:///Alias%20Repo/sub/a%23b.md', caseSensitive: true },
  ]);
  const selected = new WorkspaceSourceRoutes([
    outer,
    { ...inner, selectedPath: '/selected' },
    { ...alias, selectedPath: '/secondary' },
  ]);
  expect(selected.selectedSourcePath('/work/sub/directory/note.md')).toBe('/selected/directory/note.md');
  expect(selected.selectedSourcePath('/work/note.md')).toBe('/work/note.md');
  expect(() => selected.selectedSourcePath('/work-other/note.md')).toThrow('outside');
  expect(routes.referenceResources('missing')).toEqual([]);
  expect(new WorkspaceSourceRoutes([outer]).referenceResources('file')).toEqual([
    { uri: 'file:///work/file', caseSensitive: true },
  ]);
  expect(routes.equivalents('missing')).toEqual(['missing']);
  for (const invalid of ['Outer/../other', '/absolute', 'a\\b']) expect(routes.physicalPath(invalid)).toBeUndefined();
  const single = new WorkspaceSourceRoutes([outer]);
  expect(single.legacyPaths('AGENTS.md')).toEqual(['AGENTS.md', 'Outer/AGENTS.md']);
  expect(single.equivalents('AGENTS.md')).toEqual(['AGENTS.md']);
  expect(single.routesForPhysicalPath('/work')).toEqual(['.']);
  expect(single.routesForPhysicalPath('/unrelated')).toEqual([]);
});

it('compares physical root prefixes using their volume policy and retains exact logical labels', () => {
  const nfc = 'café';
  const nfd = nfc.normalize('NFD');
  const outer = { name: nfc, path: '/work', normalizesUnicode: true };
  const inner = { name: nfd, path: '/work/' + nfc, normalizesUnicode: true };
  const routes = new WorkspaceSourceRoutes([outer, inner]);
  expect(routes.equivalents(nfc + '/' + nfd + '/file')).toEqual([nfd + '/file', nfc + '/' + nfd + '/file']);
  expect(routes.normalizeName(nfd, nfd)).toBe(nfc);
  expect(routes.normalizeName('other', nfd)).toBe(nfd);
  expect(new WorkspaceSourceRoutes([{ ...outer, normalizesUnicode: false }]).normalizeName('relative', nfd)).toBe(nfd);
});

it('applies full Unicode case folding only on volumes that support it', () => {
  const groups = [
    ['σ', 'ς', 'Σ'],
    ['s', 'ſ', 'S'],
    ['ß', 'SS', 'ẞ'],
    ['K', 'K', 'k'],
    ['ff', 'ﬀ'],
  ];
  const root = { name: 'root', path: '/work', normalizesUnicode: true, caseSensitive: false };
  const routes = new WorkspaceSourceRoutes([{ ...root, foldsUnicode: true }]);
  for (const group of groups) expect(new Set(group.map(name => routes.normalizeName('src', name))).size).toBe(1);
  expect(routes.normalizeName('src', 'ı')).not.toBe(routes.normalizeName('src', 'i'));
  expect(routes.normalizeName('src', 'İ')).not.toBe(routes.normalizeName('src', 'I'));
  const sensitive = new WorkspaceSourceRoutes([{ ...root, caseSensitive: true }]);
  expect(sensitive.normalizeName('src', 'ß')).not.toBe(sensitive.normalizeName('src', 'SS'));
});

it('retains stored wildcard character widths and avoids resolving unrelated links', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'glyph-folded-name-')));
  try {
    mkdirSync(join(root, 'one'));
    writeFileSync(join(root, 'one', 'file'), 'file');
    symlinkSync(join(root, 'one'), join(root, 'alias'), 'dir');
    const volume = { name: 'root', path: root, normalizesUnicode: true, foldsUnicode: true, caseSensitive: false };
    const single = new WorkspaceSourceRoutes([volume]);
    const multi = new WorkspaceSourceRoutes([volume, { ...volume, name: 'other', path: join(root, 'absent') }]);
    expect(single.storedSpelling('one/file')).toBe('one/file');
    expect(multi.storedSpelling('root/one/new')).toBe('root/one/new');
    expect(single.storedSpelling('alias/file')).toBe('alias/file');
    expect(single.storedSpelling('one/file/child')).toBe('one/file/child');
    expect(single.storedSpelling('missing/child')).toBe('missing/child');
    expect(single.storedSpelling('../file')).toBe('../file');
    expect(new WorkspaceSourceRoutes([{ ...volume, foldsUnicode: false }]).storedSpelling('one/file')).toBe('one/file');
    expect(multi.storedSpelling('unknown/file')).toBe('unknown/file');
    const lookup = vi.spyOn(realpathSync, 'native');
    try {
      lookup.mockImplementationOnce(() => {
        throw new Error('unavailable');
      });
      expect(single.storedSpelling('one/file')).toBe('one/file');
      lookup.mockImplementationOnce(() => {
        throw 'unavailable';
      });
      expect(single.storedSpelling('one/file')).toBe('one/file');
    } finally {
      lookup.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('retains distinct existing entries when a filesystem uses a different Unicode table than the runtime', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'glyph-folded-entries-')));
  try {
    mkdirSync(join(root, 'source'));
    mkdirSync(join(root, 'other'));
    const policy = { name: 'volume', path: root, caseSensitive: false, normalizesUnicode: true, foldsUnicode: true };
    const routes = new WorkspaceSourceRoutes([policy]);
    const stat = fs.lstatSync;
    const redirect = (path: Parameters<typeof stat>[0]) => {
      if (path === join(root, 'ß')) return join(root, 'source');
      if (path === join(root, 'ss')) return join(root, 'other');
      if (path === join(root, 'SS')) return join(root, 'missing');
      return path;
    };
    const probe = vi
      .spyOn(fs, 'lstatSync')
      .mockImplementation((path: fs.PathLike, options?: fs.StatSyncOptions) => stat(redirect(path), options));
    try {
      const distinct = routes.scopeKey('ß/child', false);
      expect(distinct).not.toBe(routes.scopeKey('ss/child', false));
      expect(routes.scopeKey('ß/child', false)).toBe(distinct);
      expect(routes.scopeKey('SS/child', false)).not.toBe(distinct);
      const paths = new InstructionPaths(false, routes);
      const rule = (glob: string): AgentInstructionSource => ({
        id: 'rule',
        kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
        label: 'Rule',
        path: '.glyph/rules/rule.mdc',
        status: AgentInstructionSourceStatus.ACTIVE,
        scope: '.',
        globs: [glob],
      });
      for (const glob of ['ß/child', 'ß/**/*', '**/ß/child', '**/ß/*']) {
        const source = rule(glob);
        expect(matchesAgentRulePath(source, 'ss/child', paths)).toBe(false);
        expect(matchesAgentRulePath(source, 'ß/child', paths)).toBe(true);
      }
      const overlapping = new WorkspaceSourceRoutes([policy, { ...policy, name: 'nested', path: join(root, 'ß') }]);
      expect(overlapping.equivalents('volume/ss/file')).toEqual(['volume/ss/file']);
      const routed = new InstructionPaths(
        new Map([
          ['volume', false],
          ['nested', false],
        ]),
        overlapping,
      );
      expect(matchesAgentRulePath(rule('ß/child'), 'volume/ss/child', routed)).toBe(false);
      const before = probe.mock.calls.length;
      await Promise.resolve();
      expect(routes.scopeKey('ß/child', false)).toBe(distinct);
      expect(probe.mock.calls.length).toBeGreaterThan(before);
      probe.mockImplementationOnce(() => {
        throw new Error('not readable');
      });
      expect(routes.scopeKey('ſ/child', false)).toBe('ſ/child');
      expect(routes.scopeKey('../private', false)).toBeUndefined();
      const multi = new WorkspaceSourceRoutes([policy, { ...policy, name: 'elsewhere' }]);
      expect(multi.scopeKey('volume/ss/child', false)).toBe('volume/ss/child');
      expect(multi.scopeKey('unknown/child', false)).toBeUndefined();
    } finally {
      probe.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
