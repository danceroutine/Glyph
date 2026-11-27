import { expect, it } from 'vitest';
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
  expect(routes.equivalents('missing')).toEqual(['missing']);
  for (const invalid of ['Outer/../other', '/absolute', 'a\\b']) expect(routes.physicalPath(invalid)).toBeUndefined();
  const single = new WorkspaceSourceRoutes([outer]);
  expect(single.legacyPaths('AGENTS.md')).toEqual(['AGENTS.md', 'Outer/AGENTS.md']);
  expect(single.equivalents('AGENTS.md')).toEqual(['AGENTS.md']);
});
