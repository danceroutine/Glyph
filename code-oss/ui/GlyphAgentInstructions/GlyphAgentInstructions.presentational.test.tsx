import { fireEvent, render, screen, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { GlyphAgentInstructions } from './GlyphAgentInstructions.presentational.tsx';

const sources = [
  { id: 'root', kind: 'agents_md', label: 'AGENTS.md', path: 'AGENTS.md', scope: '.', status: 'active' },
  {
    id: 'nested',
    kind: 'agents_md',
    label: 'AGENTS.md',
    path: 'src/AGENTS.md',
    scope: 'src',
    status: 'error',
    message: 'File exceeds the read limit.',
  },
] as const;

describe(GlyphAgentInstructions, () => {
  it('renders sources and delegates opening one', () => {
    const openSource = vi.fn();
    const { container } = render(<GlyphAgentInstructions sources={sources} openSource={openSource} />);
    expect(screen.getByText('Applies to the workspace')).toBeTruthy();
    expect(screen.getByText('Applies to src/**')).toBeTruthy();
    expect(screen.getByText('File exceeds the read limit.')).toBeTruthy();
    expect(container.querySelector('[data-status="error"] svg')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Open src/AGENTS.md'));
    expect(openSource).toHaveBeenCalledWith(sources[1]);
  });

  it('filters sources and distinguishes filtered and empty states', () => {
    const { container, rerender } = render(
      <GlyphAgentInstructions sources={sources} query="src/" openSource={vi.fn()} />,
    );
    expect(container.querySelector('[title="Open AGENTS.md"]')).toBeNull();
    expect(container.querySelector('[title="Open src/AGENTS.md"]')).toBeTruthy();
    rerender(<GlyphAgentInstructions sources={sources} query="missing" openSource={vi.fn()} />);
    expect(container.textContent).toContain('No instruction files match your search.');
    rerender(<GlyphAgentInstructions sources={[]} openSource={vi.fn()} />);
    expect(container.textContent).toContain('No active instruction files were found in this workspace.');
  });

  it('creates and manages user rules while presenting every activation mode and detail', () => {
    const openSource = vi.fn();
    const createUserRule = vi.fn();
    const setUserRuleEnabled = vi.fn();
    const deleteUserRule = vi.fn();
    const rules = [
      {
        id: 'always',
        kind: 'glyph_user_rule',
        label: 'Glyph user rule',
        name: 'Always',
        path: '~/.glyph/rules/always.mdc',
        managementPath: 'rules/always.mdc',
        managementRevision: 'source-one',
        scope: '.',
        status: 'active',
        activation: 'always',
        enabled: true,
        revision: 'one',
        content: 'Always body',
        description: 'Description',
        globs: ['**/*.ts'],
        references: ['style.md'],
      },
      {
        id: 'files',
        kind: 'glyph_user_rule',
        label: 'Glyph user rule',
        path: '~/.glyph/rules/files.mdc',
        managementPath: 'rules/files.mdc',
        managementRevision: 'source-two',
        scope: '.',
        status: 'active',
        activation: 'file_pattern',
        enabled: false,
        revision: 'two',
      },
      {
        id: 'model',
        kind: 'glyph_project_rule',
        label: 'Glyph project rule',
        path: '.glyph/rules/model.mdc',
        scope: '.',
        status: 'active',
        activation: 'model',
        description: 'Model description only',
      },
      {
        id: 'manual',
        kind: 'glyph_project_rule',
        label: 'Glyph project rule',
        path: '.glyph/rules/manual.mdc',
        scope: '.',
        status: 'active',
        activation: 'manual',
      },
    ] as const;
    const { container } = render(
      <GlyphAgentInstructions
        sources={rules}
        openSource={openSource}
        createUserRule={createUserRule}
        setUserRuleEnabled={setUserRuleEnabled}
        deleteUserRule={deleteUserRule}
      />,
    );

    expect(container.textContent).toContain('AlwaysMatching filesModel selectedManual');
    expect(container.textContent).toContain('Description');
    expect(container.textContent).toContain('Matches: **/*.ts');
    expect(container.textContent).toContain('References: style.md');
    expect(container.textContent).toContain('Always body');
    fireEvent.submit(container.querySelector('form')!);
    expect(createUserRule).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('New user rule name'), { target: { value: 'New Rule' } });
    const activation = screen.getByLabelText<HTMLSelectElement>('Rule activation');
    fireEvent.change(activation, { target: { value: 'invalid' } });
    fireEvent.change(activation, { target: { value: 'model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(createUserRule).toHaveBeenCalledWith('New Rule', 'model');
    expect(screen.getByLabelText<HTMLInputElement>('New user rule name').value).toBe('');

    const always = container.querySelectorAll<HTMLElement>('.instruction-source')[0]!;
    fireEvent.click(within(always).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(always).getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(always).getByRole('button', { name: 'Remove' }));
    expect(openSource).toHaveBeenCalledWith(rules[0]);
    expect(setUserRuleEnabled).toHaveBeenCalledWith(rules[0], false);
    expect(deleteUserRule).toHaveBeenCalledWith(rules[0]);

    const files = container.querySelectorAll<HTMLElement>('.instruction-source')[1]!;
    fireEvent.click(within(files).getByRole('button', { name: 'Enable' }));
    expect(setUserRuleEnabled).toHaveBeenCalledWith(rules[1], true);
  });
});
