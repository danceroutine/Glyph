import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphSkill } from '#src/desktop/protocol/events/GlyphSkill.js';
import { GlyphSkills } from '#code-oss/ui/GlyphSkills/GlyphSkills.presentational.tsx';

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

describe('Skill management', () => {
  afterEach(cleanup);
  function actions() {
    return {
      targets: [{ id: 'project', label: 'Project skills' }],
      previewDraft: vi.fn(async () => {}),
      installLocal: vi.fn(async () => {}),
      previewRepository: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      apply: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    };
  }
  it('reveals directional controls and filename line breaks while preserving the exact reviewed data', () => {
    const path = 'report\u202Ejs\n.txt';
    const source = 'مرحبا\nconst value = "\u2066hidden";';
    const preview = {
      id: 'preview',
      targetId: 'project',
      action: 'install' as const,
      name: 'review',
      source: 'Local\u202Epackage',
      revision: 'exact-revision',
      destination: { scope: 'project' as const, label: 'Project', path: '/project/skills/review' },
      files: [{ path, status: 'added' as const, after: source }],
    };
    render(<GlyphSkills skills={[]} edit={vi.fn()} management={{ ...actions(), preview }} />);
    expect(screen.getByText('report\\u202Ejs\\u000A.txt')).toBeDefined();
    expect(screen.getByText(/Local\\u202Epackage/u)).toBeDefined();
    expect(screen.getByLabelText('After report\\u202Ejs\\u000A.txt').textContent).toBe(
      'مرحبا\nconst value = "\\u2066hidden";',
    );
    expect(preview.files[0]?.after).toBe(source);
    expect(preview.files[0]?.path).toBe(path);
  });
  it('previews a draft with the selected scope and delegates enablement, local update, and removal', async () => {
    const management = actions();
    render(<GlyphSkills skills={[skill]} edit={vi.fn()} management={management} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create skill', exact: true }));
    fireEvent.input(screen.getByLabelText('Name', { exact: true }), { target: { value: 'workflow' } });
    fireEvent.input(screen.getByLabelText('Description', { exact: true }), { target: { value: 'Reusable workflow' } });
    fireEvent.input(screen.getByLabelText('Instructions', { exact: true }), { target: { value: 'Run the checks.' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Preview package' }).closest('form')!);
    await vi.waitFor(() => {
      expect(management.previewDraft).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          name: 'workflow',
          files: [expect.objectContaining({ content: expect.stringContaining('Run the checks.') })],
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disable', exact: true }));
    await vi.waitFor(() => {
      expect(management.setEnabled).toHaveBeenCalledWith(skill.id, false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update', exact: true }));
    await vi.waitFor(() => {
      expect(management.installLocal).toHaveBeenCalledWith('project', skill.id);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall', exact: true }));
    await vi.waitFor(() => {
      expect(management.remove).toHaveBeenCalledWith(skill.id);
    });
  });
  it('shows a failed discovery location without offering package mutations', () => {
    const { revision: _, ...unversioned } = skill;
    render(
      <GlyphSkills
        skills={[
          {
            ...unversioned,
            enabled: false,
            status: 'error',
            path: '',
            directory: '',
            uri: '',
            message: 'User skill location unavailable',
          },
        ]}
        edit={vi.fn()}
        management={actions()}
      />,
    );
    expect(screen.getByText('User skill location unavailable')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull();
  });
  it('shows exact preview comparisons, applies its token, and displays operation errors', async () => {
    const management = {
      ...actions(),
      preview: {
        id: 'token',
        targetId: 'project',
        destination: { label: 'App project skills', scope: 'project' as const, path: '/project/.glyph/skills/review' },
        action: 'update' as const,
        name: 'review',
        source: 'Pinned repository',
        revision: '123456789012',
        files: [{ path: 'SKILL.md', status: 'modified' as const, before: 'Before', after: 'After' }],
      },
    };
    management.apply.mockRejectedValueOnce(new Error('The package changed. Preview again.'));
    render(
      <GlyphSkills
        skills={[{ ...skill, installedFrom: 'Repository @ version', packageRevision: 'version' }]}
        edit={vi.fn()}
        management={management}
      />,
    );
    expect(screen.getByText('/project/.glyph/skills/review')).toBeDefined();
    expect(screen.getByText('Before')).toBeDefined();
    expect(screen.getByText('After')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Apply update' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Preview again');
    });
    expect(management.apply).toHaveBeenCalledWith('token');
    fireEvent.click(screen.getByRole('button', { name: 'Discard preview' }));
    await vi.waitFor(() => {
      expect(management.discard).toHaveBeenCalledWith('token');
    });
  });
  it('collects the repository revision and package directory before requesting a preview', async () => {
    const management = actions();
    render(<GlyphSkills skills={[]} edit={vi.fn()} management={management} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install from repository' }));
    fireEvent.input(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.test/skills.git' } });
    fireEvent.input(screen.getByLabelText('Revision', { exact: true }), { target: { value: 'selected-sha' } });
    fireEvent.input(screen.getByLabelText('Package directory'), { target: { value: 'example' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Preview package' }).closest('form')!);
    await vi.waitFor(() => {
      expect(management.previewRepository).toHaveBeenCalledWith(
        'project',
        { kind: 'repository', url: 'https://example.test/skills.git', revision: 'selected-sha', directory: 'example' },
        undefined,
      );
    });
  });
  it('routes local installs to the chosen scope and keeps repository updates bound to the installed origin', async () => {
    const management = {
      ...actions(),
      targets: [
        { id: 'user', label: 'User' },
        { id: 'project', label: 'Project' },
      ],
      message: 'Refresh Skills',
    };
    render(<GlyphSkills skills={[skill]} edit={vi.fn()} management={management} />);
    expect(screen.getByRole('status').textContent).toBe('Refresh Skills');
    fireEvent.change(screen.getByLabelText('Skill installation scope'), { target: { value: 'user' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install local package' }));
    await vi.waitFor(() => {
      expect(management.installLocal).toHaveBeenCalledWith('user');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Instructions')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update from repository' }));
    fireEvent.input(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.test/review.git' } });
    fireEvent.input(screen.getByLabelText('Revision', { exact: true }), { target: { value: 'v2' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Preview package' }).closest('form')!);
    await vi.waitFor(() => {
      expect(management.previewRepository).toHaveBeenCalledWith(
        'project',
        { kind: 'repository', url: 'https://example.test/review.git', revision: 'v2', directory: '' },
        skill.id,
      );
    });
  });
  it('enables compatible packages without offering native package mutations and reports non-Error failures', async () => {
    const management = actions();
    management.setEnabled.mockRejectedValueOnce('Permission denied');
    render(
      <GlyphSkills
        skills={[
          { ...skill, enabled: false, origin: { ...skill.origin, id: 'cursor' }, installedFrom: 'Manual import' },
        ]}
        edit={vi.fn()}
        management={management}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable', exact: true }));
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Permission denied');
    });
    expect(management.setEnabled).toHaveBeenCalledWith(skill.id, true);
  });
});
