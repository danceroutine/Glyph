import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProjectSkillIdentity } from '#src/skills/ProjectSkillIdentity.js';
import { skillPackageId } from '#src/skills/skillPackageId.js';

it('keeps the ID and profile provenance of the same package when a different ancestor is attached', () => {
  const root = '/workspace';
  const outer = new ProjectSkillIdentity(root, '.glyph');
  const inner = new ProjectSkillIdentity(join(root, 'sub'), '.glyph');
  const directory = '.glyph/skills/example';
  const current = inner.forDirectory(directory);
  const old = skillPackageId(outer.originId, 'sub/' + directory);
  expect(current).toBe(skillPackageId(inner.originId, directory));
  expect(outer.forDirectory('sub/' + directory)).toBe(current);
  expect(outer.forDirectory(directory)).not.toBe(current);
  expect(inner.legacyIds(directory)).toContain(old);
  expect(new ProjectSkillIdentity('/', '.glyph').legacyIds(directory)).toEqual([]);
});

it('verifies exactly one stored plain or hashed ID within a shared ancestor budget', () => {
  const outer = new ProjectSkillIdentity('/root', '.glyph');
  const nested = new ProjectSkillIdentity('/root/sub', '.glyph');
  const directory = '.glyph/skills/example';
  const budget = { remaining: 100 };
  const old = skillPackageId(outer.originId, 'sub/' + directory);
  expect(nested.matchesLegacyId(directory, old, budget)).toBe(true);
  expect(nested.matchesLegacyId(directory, old.replace('sub/', 'other/'), budget)).toBe(false);
  expect(nested.matchesLegacyId(directory, old.replace('.glyph:', '.cursor:'), budget)).toBe(false);
  expect(nested.matchesLegacyId(directory, 'unknown', budget)).toBe(false);
  const deep = 'long/'.repeat(110) + directory;
  const hashed = skillPackageId(outer.originId, 'sub/' + deep);
  expect(nested.matchesLegacyId(deep, hashed, { remaining: 0 })).toBe(false);
  expect(nested.matchesLegacyId(deep, hashed, { remaining: 200 })).toBe(true);
  expect(nested.matchesLegacyId(deep, 'skill-sha256:' + '0'.repeat(64), { remaining: 200 })).toBe(false);
  expect(nested.matchesLegacyId(directory, hashed, budget)).toBe(false);
});
