import { fireEvent, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { Dimension } from '#vs/base/browser/dom.js';
import { URI } from '#vs/base/common/uri.js';
import { GlyphAgentInstructionsPreferences } from '#vs/workbench/contrib/glyph/browser/GlyphAgentInstructionsPreferences.js';

describe(GlyphAgentInstructionsPreferences, () => {
  it('lists active and failed sources, filters them, and opens workspace files', () => {
    let changed: (() => void) | undefined;
    const state = {
      instructionSources: [
        {
          id: 'root',
          kind: 'agents_md',
          label: 'AGENTS.md',
          path: 'AGENTS.md',
          scope: '.',
          status: 'active' as const,
        },
        {
          id: 'nested',
          kind: 'agents_md',
          label: 'AGENTS.md',
          path: 'src/AGENTS.md',
          scope: 'src',
          status: 'error' as const,
          message: 'File exceeds the read limit.',
        },
      ],
    };
    const glyph = {
      openLink: vi.fn(async () => {}),
      state,
      onDidChangeState: (listener: () => void) => {
        changed = listener;
        return { dispose: vi.fn() };
      },
    };
    const page = new GlyphAgentInstructionsPreferences(glyph as never);

    page.layout(new Dimension(800, 600));
    expect(page.getDomNode().style.height).toBe('600px');
    expect(page.getDomNode().textContent).toContain('AGENTS.md');
    expect(page.getDomNode().textContent).toContain('Applies to the workspace');
    expect(page.getDomNode().textContent).toContain('Applies to src/**');
    expect(page.getDomNode().textContent).toContain('File exceeds the read limit.');

    page.getDomNode().querySelector<HTMLButtonElement>('button.source-path')!.click();
    expect(glyph.openLink).toHaveBeenCalledWith('glyph-instruction:root');
    expect(page.getDomNode().querySelectorAll<HTMLButtonElement>('button.source-path')[1].disabled).toBe(true);

    page.search('src/');
    expect(page.getDomNode().querySelectorAll('.instruction-source')).toHaveLength(1);
    page.search('missing');
    expect(page.getDomNode().textContent).toContain('No instruction files match your search.');
    state.instructionSources = [];
    page.search('');
    changed?.();
    expect(page.getDomNode().textContent).toContain('No active instruction files were found');
    page.dispose();
  });

  it('requests fresh sources on open and on search, and reports refresh errors in the pane', async () => {
    const refreshInstructionSources = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Catalog unavailable.'));
    const page = new GlyphAgentInstructionsPreferences({
      state: { instructionSources: [], readOnly: true },
      onDidChangeState: () => ({ dispose() {} }),
      refreshInstructionSources,
    } as never);
    await waitFor(() => {
      expect(page.getDomNode().textContent).toContain('Catalog unavailable.');
    });
    expect(page.getDomNode().querySelector('form')).toBeNull();
    page.search('root');
    await waitFor(() => {
      expect(page.getDomNode().textContent).not.toContain('Catalog unavailable.');
    });
    refreshInstructionSources.mockRejectedValueOnce('disconnected');
    page.search('');
    await waitFor(() => {
      expect(page.getDomNode().textContent).toContain('Agent Instructions could not be refreshed.');
    });
    expect(refreshInstructionSources).toHaveBeenCalledTimes(3);
    page.dispose();
  });
  it('handles an absent catalog', () => {
    const page = new GlyphAgentInstructionsPreferences({
      state: {},
      onDidChangeState: () => ({ dispose() {} }),
    } as never);
    expect(page.getDomNode().textContent).toContain('No active instruction files were found');
    page.dispose();
  });
  it('forwards user rule management and opens direct source URIs', () => {
    const createUserRule = vi.fn(async () => {});
    const setUserRuleEnabled = vi.fn(async () => {});
    const deleteUserRule = vi.fn(async () => {});
    const openLink = vi.fn(async () => {});
    const source = {
      id: 'user',
      kind: 'glyph_user_rule',
      label: 'Glyph user rule',
      path: '~/.glyph/rules/test.mdc',
      managementPath: 'rules/test.mdc',
      managementRevision: 'source-one',
      uri: URI.file('/home/user/.glyph/rules/test.mdc').toString(),
      scope: '.',
      status: 'active',
      activation: 'manual',
      revision: 'one',
      enabled: true,
    };
    const page = new GlyphAgentInstructionsPreferences({
      state: { instructionSources: [source] },
      onDidChangeState: () => ({ dispose() {} }),
      openLink,
      createUserRule,
      setUserRuleEnabled,
      deleteUserRule,
    } as never);
    const root = page.getDomNode();
    const input = root.querySelector<HTMLInputElement>('[aria-label="New user rule name"]')!;
    fireEvent.input(input, { target: { value: 'My Rule' } });
    const activation = root.querySelector<HTMLSelectElement>('[aria-label="Rule activation"]')!;
    fireEvent.change(activation, { target: { value: 'always' } });
    fireEvent.submit(root.querySelector('form')!);
    root.querySelector<HTMLButtonElement>('button.source-path')!.click();
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Disable')!.click();
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove')!.click();

    expect(createUserRule).toHaveBeenCalledWith('My Rule', 'manual', undefined);
    expect(setUserRuleEnabled).toHaveBeenCalledWith(source, false);
    expect(deleteUserRule).toHaveBeenCalledWith(source);
    expect(openLink).toHaveBeenCalledWith('glyph-instruction:user');
    page.dispose();
  });
});
