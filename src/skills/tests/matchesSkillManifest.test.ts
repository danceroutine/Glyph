import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { matchesSkillManifest } from '../matchesSkillManifest.ts';

it('admits an authorized root alias and checks the actual manifest and every containing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-skill-open-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, 'project');
  const other = join(root, 'other');
  for (const dir of [project, other]) mkdirSync(join(dir, 'skills', 'one'), { recursive: true });
  const path = 'skills/one/SKILL.md';
  writeFileSync(join(project, path), 'manifest');
  const uri = (p: string) => pathToFileURL(p).toString();
  const source = { uri: uri(join(project, path)), path };
  symlinkSync(project, join(root, 'editor'));
  expect(matchesSkillManifest(source, uri(join(root, 'editor', path)))).toBe(true);
  expect(matchesSkillManifest(source, 'https://example.com')).toBe(false);
  writeFileSync(join(other, path), 'distinct');
  expect(matchesSkillManifest(source, uri(join(other, path)))).toBe(false);
  rmSync(join(other, path));
  linkSync(join(project, path), join(other, path));
  expect(matchesSkillManifest(source, uri(join(other, path)))).toBe(false);
  rmSync(join(other, path));
  symlinkSync(join(project, path), join(other, path));
  expect(matchesSkillManifest(source, uri(join(other, path)))).toBe(false);
  expect(matchesSkillManifest({ uri: uri(project), path: 'SKILL.md' }, uri(project))).toBe(false);
});
