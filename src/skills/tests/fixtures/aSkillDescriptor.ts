import { createHash } from 'node:crypto';
import type { SkillDescriptor } from '#src/skills/SkillDescriptor.js';
import { SkillPackage } from '#src/skills/SkillPackage.js';

export function aSkillDescriptor(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    id: 'project:example',
    origin: { id: 'project', label: 'Project skill', scope: 'project', compatibility: 'glyph' },
    path: '.glyph/skills/example/SKILL.md',
    directory: '.glyph/skills/example',
    scope: '.',
    name: 'example',
    description: 'Use for examples',
    enabled: true,
    status: 'active',
    revision: 'manifest-revision',
    allowedTools: [],
    uri: 'file:///workspace/.glyph/skills/example/SKILL.md',
    ...overrides,
  };
}

export function aSkillPackage(
  descriptor = aSkillDescriptor(),
  body = 'Skill instructions',
  resources: Readonly<Record<string, Uint8Array>> = {},
) {
  return new SkillPackage(
    descriptor,
    body,
    new Map(
      Object.entries(resources).map(([path, bytes]) => [
        path,
        { bytes, revision: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 },
      ]),
    ),
  );
}
