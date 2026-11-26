import { describe, expect, it, vi } from 'vitest';
import { URI } from '#vs/base/common/uri.js';
import { GlyphSkillsPreferences } from '#vs/workbench/contrib/glyph/browser/GlyphSkillsPreferences.js';
import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';

describe(GlyphSkillsPreferences, () => {
  it('opens the selected skill in a pinned native editor and follows host updates and Settings search', () => {
    let changed: (() => void) | undefined;
    const state: { skills: GlyphSkill[] } = {
      skills: [
        {
          id: 'project:example',
          origin: { id: 'project', label: 'Project skill', scope: 'project', compatibility: 'glyph' },
          path: '.glyph/skills/example/SKILL.md',
          directory: '.glyph/skills/example',
          scope: '.',
          name: 'example',
          description: 'Use for examples',
          enabled: true,
          status: 'active',
          allowedTools: [],
          uri: 'file:///workspace/.glyph/skills/example/SKILL.md',
        },
      ],
    };
    const editors = { openEditor: vi.fn(async () => undefined) };
    const refreshSkills = vi.fn(async () => undefined);
    const page = new GlyphSkillsPreferences(
      {
        state,
        refreshSkills,
        onDidChangeState: (listener: () => void) => {
          changed = listener;
          return { dispose: vi.fn() };
        },
      } as never,
      editors as never,
    );
    expect(refreshSkills).toHaveBeenCalledOnce();
    page.layout({ width: 900, height: 600 });
    expect(page.getDomNode().style.height).toBe('600px');
    page.getDomNode().querySelector<HTMLButtonElement>('button')!.click();
    expect(editors.openEditor).toHaveBeenCalledExactlyOnceWith({
      resource: URI.parse(state.skills[0].uri),
      options: { pinned: true },
    });
    page.search('not-found');
    expect(refreshSkills).toHaveBeenCalledTimes(2);
    expect(page.getDomNode().textContent).toContain('No skills match your search.');
    page.search('');
    state.skills = [];
    changed?.();
    expect(page.getDomNode().textContent).toContain('No skills found.');
    page.dispose();
  });
});
