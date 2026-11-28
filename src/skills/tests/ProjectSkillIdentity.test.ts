import { UserSkillDirectory } from '#src/skills/UserSkillDirectory.js';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProjectSkillIdentity } from '#src/skills/ProjectSkillIdentity.js';
import { skillPackageId } from '#src/skills/skillPackageId.js';
import { aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

it('keeps the ID and profile provenance of the same package when a different ancestor is attached', async () => {
  const { root, state } = await aSkillLifecycle();
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
  const aliases = new Map([[current, [old, 'other']]]);
  await state.migratePackageIds(aliases);
  await state.setEnabled(old, true, new AbortController().signal);
  await state.setEnabled('other', false, new AbortController().signal);
  await state.record(old, 'Original import', 'first');
  await state.migratePackageIds(aliases);
  expect(state.enabled.get(current)).toBe(false);
  expect(state.enabled.has(old)).toBe(false);
  expect(state.installations.get(current)).toEqual({ source: 'Original import', revision: 'first' });
  await state.setEnabled(old, true, new AbortController().signal);
  await state.record(old, 'Other', 'second');
  await state.migratePackageIds(aliases);
  expect(state.enabled.get(current)).toBe(false);
  expect(state.installations.get(current)?.source).toBe('Original import');
  await state.forget(current);
  await state.record(old, 'Provenance only', 'revision');
  await state.migratePackageIds(aliases);
  expect(state.installations.get(current)?.source).toBe('Provenance only');
  expect(state.enabled.has(current)).toBe(false);
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

it('keeps user packages reachable through their former project references across root changes', () => {
  const profile = new UserSkillDirectory('/repo/sub/.Glyph', false);
  const source = 'skills/example';
  const nested = new ProjectSkillIdentity('/repo/sub', '.glyph');
  const outer = new ProjectSkillIdentity('/repo', '.glyph');
  expect(profile.ownsStore('/repo/sub/.glyph/skills')).toBe(true);
  expect(profile.matchesProjectReference(source, nested.forDirectory('.Glyph/' + source), { remaining: 32 })).toBe(
    true,
  );
  const previous = skillPackageId(outer.originId, 'sub/.Glyph/' + source);
  expect(profile.matchesProjectReference(source, previous, { remaining: 32 })).toBe(true);
  expect(profile.matchesProjectReference('skills/other', previous, { remaining: 32 })).toBe(false);
  const distinct = new UserSkillDirectory('/repo/sub/.Glyph', true);
  expect(distinct.ownsStore('/repo/sub/.glyph/skills')).toBe(false);
  expect(distinct.matchesProjectReference(source, previous, { remaining: 32 })).toBe(false);
});

it('retains indexed project IDs for a user skill exposed through a differently named mount', async () => {
  const { mkdtemp, mkdir, symlink, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-user-skill-alias-')));
  try {
    const profile = join(root, 'profile');
    await mkdir(join(profile, 'skills/one'), { recursive: true });
    await symlink(profile, join(root, '.glyph'));
    const alias = join(root, '.glyph', 'skills');
    const directory = new UserSkillDirectory(profile, true, () => [join(profile, 'skills'), alias]);
    directory.refresh();
    expect(directory.ownsPackage(join(alias, 'one'))).toBe(true);
    const id = new ProjectSkillIdentity(root, '.glyph').forDirectory('.glyph/skills/one');
    expect(directory.previousPackageIds('skills/one')).toContain(id);
    expect(directory.matchesProjectReference('skills/one', id, { remaining: 20 })).toBe(true);
    expect(directory.matchesProjectReference('skills/two', id, { remaining: 20 })).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
