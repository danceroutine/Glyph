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
