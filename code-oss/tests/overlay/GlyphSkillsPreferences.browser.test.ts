import { describe, expect, it, vi } from 'vitest';
import { GlyphSkillsPreferences } from '#vs/workbench/contrib/glyph/browser/GlyphSkillsPreferences.js';
import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';

describe(GlyphSkillsPreferences, () => {
  it('requests the selected skill by ID and follows host updates and Settings search', async () => {
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
    const openLink = vi.fn(async () => undefined);
    const notification = { error: vi.fn() };
    const refreshSkills = vi.fn(async () => undefined);
    const page = new GlyphSkillsPreferences(
      {
        state,
        refreshSkills,
        openLink,
        onDidChangeState: (listener: () => void) => {
          changed = listener;
          return { dispose: vi.fn() };
        },
      } as never,
      notification as never,
    );
    expect(refreshSkills).toHaveBeenCalledOnce();
    page.layout({ width: 900, height: 600 });
    expect(page.getDomNode().style.height).toBe('600px');
    page.getDomNode().querySelector<HTMLButtonElement>('button')!.click();
    expect(openLink).toHaveBeenCalledExactlyOnceWith('glyph-skill:project%3Aexample');
    openLink.mockRejectedValueOnce(new Error('Skill removed.'));
    page.getDomNode().querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => {
      expect(notification.error).toHaveBeenCalledWith('Skill removed.');
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
