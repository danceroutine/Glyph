import { describe, expect, it, vi } from 'vitest';
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
      state,
      onDidChangeState: (listener: () => void) => {
        changed = listener;
        return { dispose: vi.fn() };
      },
    };
    const workspace = {
      getWorkspace: () => ({ folders: [{ name: 'workspace', uri: URI.file('/workspace') }] }),
    };
    const editors = { openEditor: vi.fn(async () => undefined) };
    const page = new GlyphAgentInstructionsPreferences(glyph as never, workspace as never, editors as never);

    page.layout({ width: 800, height: 600 });
    expect(page.getDomNode().style.height).toBe('600px');
    expect(page.getDomNode().textContent).toContain('AGENTS.md');
    expect(page.getDomNode().textContent).toContain('Applies to the workspace');
    expect(page.getDomNode().textContent).toContain('Applies to src/**');
    expect(page.getDomNode().textContent).toContain('File exceeds the read limit.');

    page.getDomNode().querySelector<HTMLButtonElement>('button.source-path')!.click();
    expect(editors.openEditor).toHaveBeenCalledWith({ resource: URI.file('/workspace/AGENTS.md') });

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

  it('opens a source from its named workspace root', () => {
    const editors = { openEditor: vi.fn(async () => undefined) };
    const page = new GlyphAgentInstructionsPreferences(
      {
        state: {
          instructionSources: [
            {
              id: 'root',
              kind: 'agents_md',
              label: 'AGENTS.md',
              path: 'api/AGENTS.md',
              scope: 'api',
              status: 'active',
            },
          ],
        },
        onDidChangeState: () => ({ dispose() {} }),
      } as never,
      {
        getWorkspace: () => ({
          folders: [
            { name: 'web', uri: URI.file('/web') },
            { name: 'api', uri: URI.file('/api') },
          ],
        }),
      } as never,
      editors as never,
    );

    page.getDomNode().querySelector<HTMLButtonElement>('button.source-path')!.click();
    expect(editors.openEditor).toHaveBeenCalledWith({ resource: URI.file('/api/AGENTS.md') });
    page.dispose();
  });

  it('handles an absent catalog and paths that do not resolve to a workspace folder', () => {
    const editors = { openEditor: vi.fn(async () => undefined) };
    const glyph = {
      state: {} as { instructionSources?: readonly unknown[] },
      onDidChangeState: () => ({ dispose() {} }),
    };
    const page = new GlyphAgentInstructionsPreferences(
      glyph as never,
      { getWorkspace: () => ({ folders: [] }) } as never,
      editors as never,
    );
    expect(page.getDomNode().textContent).toContain('No active instruction files were found');
    page.dispose();

    const sourceState = {
      state: {
        instructionSources: [
          {
            id: 'missing',
            kind: 'agents_md',
            label: 'AGENTS.md',
            path: 'missing/AGENTS.md',
            scope: 'missing',
            status: 'active',
          },
        ],
      },
      onDidChangeState: () => ({ dispose() {} }),
    };
    const noFolders = new GlyphAgentInstructionsPreferences(
      sourceState as never,
      { getWorkspace: () => ({ folders: [] }) } as never,
      editors as never,
    );
    noFolders.getDomNode().querySelector<HTMLButtonElement>('button.source-path')!.click();
    expect(editors.openEditor).not.toHaveBeenCalled();
    noFolders.dispose();

    const unresolved = new GlyphAgentInstructionsPreferences(
      sourceState as never,
      {
        getWorkspace: () => ({
          folders: [
            { name: 'web', uri: URI.file('/web') },
            { name: 'api', uri: URI.file('/api') },
          ],
        }),
      } as never,
      editors as never,
    );
    unresolved.getDomNode().querySelector<HTMLButtonElement>('button.source-path')!.click();
    expect(editors.openEditor).not.toHaveBeenCalled();
    unresolved.dispose();
  });
});
