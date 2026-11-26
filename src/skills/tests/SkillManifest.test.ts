import { describe, expect, it } from 'vitest';
import { parseSkillManifest } from '#src/skills/SkillManifest.js';

describe(parseSkillManifest, () => {
  it('parses standard YAML metadata separately from instructions', () => {
    expect(
      parseSkillManifest(
        '---\nname: example\ndescription: >-\n  Use for\n  examples.\nmetadata:\n  author: test\nallowed-tools: Read Bash(git:*)\n---\n# Instructions\n',
        'example',
      ),
    ).toMatchObject({
      name: 'example',
      description: 'Use for examples.',
      metadata: { author: 'test' },
      allowedTools: ['Read', 'Bash(git:*)'],
      body: '# Instructions\n',
    });
  });
  it.each([
    'No frontmatter',
    '---\nname: example\ndescription: use\n',
    '---\nname: different\ndescription: use\n---\nBody',
    '---\nname: example\nname: example\ndescription: use\n---\nBody',
    '---\nname: example\ndescription: ""\n---\nBody',
    '---\nname: example\ndescription: use\nmetadata: [wrong]\n---\nBody',
    `---\nname: example\ndescription: ${'x'.repeat(1025)}\n---\nBody`,
  ])('rejects invalid manifests', text => {
    expect(() => parseSkillManifest(text, 'example')).toThrow();
  });
});
