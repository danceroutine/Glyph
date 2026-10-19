import { describe, it, expect } from 'vitest';
import { StoryIndexGenerator } from 'storybook/internal/core-server';
import { resolve } from 'node:path';

describe('Storybook live indexing', () => {
  it('reindexes a TSX story invalidated between the story and docs passes using the CSF indexer', async () => {
    const path = resolve('code-oss/ui/GlyphComposer/GlyphComposer.stories.tsx');
    const specifier = { directory: '.', files: '**/*.stories.tsx', importPathMatcher: /\.stories\.tsx$/ };
    const generator = new StoryIndexGenerator([specifier], { workingDir: process.cwd() });
    generator.specifierToCache.set(specifier, { [path]: false });
    let indexed = 0;
    generator.extractStories = async () => {
      indexed++;
      return {
        type: 'stories',
        entries: [{ type: 'story', id: 'glyph-chat-composer--empty', extra: { stats: {} } }],
        dependents: [],
      };
    };
    const original = generator.updateExtracted.bind(generator);
    let pass = 0;
    generator.updateExtracted = async updater => {
      await original(updater);
      if (++pass === 1) generator.invalidate('./code-oss/ui/GlyphComposer/GlyphComposer.stories.tsx', false);
    };
    const result = await generator.ensureExtracted({ projectTags: [] });
    expect(result.entries).toEqual([expect.objectContaining({ id: 'glyph-chat-composer--empty', type: 'story' })]);
    expect(indexed).toBe(2);
  });
});
