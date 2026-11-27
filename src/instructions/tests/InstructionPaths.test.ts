import { describe, expect, it } from 'vitest';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';

describe(InstructionPaths, () => {
  const roots = new InstructionPaths(
    new Map([
      ['App', false],
      ['app', true],
    ]),
  );
  it('compares paths with the casing of the routed root while preserving distinct aliases', () => {
    expect(roots.contains('App/Src', 'App/src/A.ts')).toBe(true);
    expect(roots.contains('App/Src', 'app/src/A.ts')).toBe(false);
    expect(roots.contains('app/Src', 'app/src/A.ts')).toBe(false);
    expect(roots.caseSensitive('other/path')).toBe(true);
    expect(new InstructionPaths(false).contains('SRC', 'src')).toBe(true);
  });
  it('resolves references through the original root while allowing parents within that root', () => {
    expect(roots.reference('App/src', '../guide.md')).toBe('App/guide.md');
    expect(() => roots.reference('App', '../app/guide.md')).toThrow('leaves');
    expect(() => new InstructionPaths().reference('.', '..')).toThrow('leaves');
    for (const invalid of ['', '/absolute', 'C:local', 'a\\b', 'a\0b'])
      expect(() => roots.reference('App', invalid)).toThrow('relative');
  });
});

it('matches relative patterns under the same physical scope through every attached root', async () => {
  const { WorkspaceSourceRoutes } = await import('#src/workspace/WorkspaceSourceRoutes.js');
  const routes = new WorkspaceSourceRoutes([
    { name: 'outer', path: '/app' },
    { name: 'inner', path: '/app/sub' },
  ]);
  const paths = new InstructionPaths(
    new Map([
      ['outer', false],
      ['inner', false],
    ]),
    routes,
  );
  expect(paths.contains('inner', 'outer/sub/file')).toBe(true);
  expect(paths.relativeToScope('inner', 'outer/sub/file')).toBe('file');
  expect(paths.relativeToScope('inner', 'outer/sub')).toBe('');
  expect(paths.contains('inner/src', 'outer/sub/docs')).toBe(false);
});

it('resolves old physical rule IDs only when the current filesystem identifies a single source', async () => {
  const { WorkspaceSourceRoutes } = await import('#src/workspace/WorkspaceSourceRoutes.js');
  const { resolveInstructionId } = await import('#src/instructions/resolveInstructionId.js');
  const { AgentInstructionSourceKind } = await import('#src/instructions/AgentInstructionSource.js');
  const routes = new WorkspaceSourceRoutes([{ name: 'root', path: '/physical' }]);
  const kind = AgentInstructionSourceKind.GLYPH_PROJECT_RULE;
  const paths = new InstructionPaths(true, routes, true);
  const upper = paths.sourceIdentity(kind, 'API.mdc');
  const lower = paths.sourceIdentity(kind, 'api.mdc');
  const old = new InstructionPaths(false, routes, true).sourceIdentity(kind, 'API.mdc').id;
  expect(upper.id).not.toBe(lower.id);
  expect(resolveInstructionId([upper, lower], old)).toBeUndefined();
  expect(resolveInstructionId([upper], old)).toBe(upper);
  expect(resolveInstructionId([upper, lower], lower.id)).toBe(lower);
  expect(new InstructionPaths(true, routes, false).sourceIdentity(kind, 'api.mdc').id).toBe(old);
  expect(new InstructionPaths(false, routes, false).sourceIdentity(kind, 'API.mdc').id).toBe(old);
});
