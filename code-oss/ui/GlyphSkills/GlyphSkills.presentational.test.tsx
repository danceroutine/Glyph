import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphSkill } from '#src/desktop/protocol/events/GlyphSkill.js';
import { GlyphSkills } from './GlyphSkills.presentational.tsx';

const skill: GlyphSkill = {
  id: 'project:review',
  origin: { id: 'project', label: 'Project skill', scope: 'project', compatibility: 'glyph' },
  path: '.glyph/skills/review/SKILL.md',
  directory: '.glyph/skills/review',
  scope: '.',
  name: 'review',
  description: 'Use for code review',
  enabled: true,
  status: 'active',
  allowedTools: [],
  uri: 'file:///workspace/.glyph/skills/review/SKILL.md',
  revision: 'abcdef123',
};

describe(GlyphSkills, () => {
  afterEach(cleanup);
  it('shows metadata without bodies and delegates Edit with the exact scoped skill', () => {
    const edit = vi.fn();
    render(
      <GlyphSkills
        skills={[
          skill,
          {
            ...skill,
            id: 'user:review',
            origin: { ...skill.origin, id: 'user', label: 'User skill', scope: 'user' },
            enabled: false,
          },
        ]}
        edit={edit}
      />,
    );
    expect(screen.getAllByText('Use for code review')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit review · Project skill' }));
    expect(edit).toHaveBeenCalledExactlyOnceWith(skill);
    expect(screen.getByText(/User skill · Disabled/u)).toBeDefined();
  });
  it('filters metadata and reports malformed packages without hiding valid ones', () => {
    render(
      <GlyphSkills
        skills={[
          skill,
          {
            ...skill,
            id: 'bad',
            name: 'bad',
            description: 'Bad package',
            status: 'error',
            message: 'Missing SKILL.md',
            compatibility: 'Requires Python',
            scope: 'docs',
          },
        ]}
        query="Missing"
        edit={vi.fn()}
      />,
    );
    expect(screen.queryByText('Use for code review')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Missing SKILL.md');
    expect(screen.getByText('Compatibility: Requires Python')).toBeDefined();
  });
  it.each(['', 'missing'])('shows an appropriate empty state for %s', query => {
    render(<GlyphSkills skills={[]} query={query} edit={vi.fn()} />);
    expect(screen.getByText(query ? 'No skills match your search.' : /No skills found/u)).toBeDefined();
  });
});
