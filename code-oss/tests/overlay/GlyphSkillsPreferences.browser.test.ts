import { URI } from '#vs/base/common/uri.js';
import { describe, expect, it, vi } from 'vitest';
import { GlyphSkillsPreferences } from '#vs/workbench/contrib/glyph/browser/GlyphSkillsPreferences.js';
import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';
import type { GlyphDesktopSnapshot } from '#glyph/protocol/events/GlyphDesktopSnapshot.js';
import { act, fireEvent, within } from '@testing-library/preact';

describe(GlyphSkillsPreferences, () => {
  it('routes Settings management through native file selection and revision-bound host commands and respects read-only state', async () => {
    let changed: (() => void) | undefined;
    const skill: GlyphSkill = {
      id: 'project:example',
      name: 'example',
      description: 'Fixture workflow',
      directory: '.glyph/skills/example',
      path: '.glyph/skills/example/SKILL.md',
      scope: '.',
      status: 'active',
      enabled: true,
      allowedTools: [],
      uri: 'file:///workspace/.glyph/skills/example/SKILL.md',
      origin: { id: 'project', label: 'Project', scope: 'project', compatibility: 'glyph' },
    };
    const state: Pick<
      GlyphDesktopSnapshot,
      'skills' | 'skillTargets' | 'skillPreview' | 'skillManagementMessage' | 'readOnly'
    > = {
      readOnly: false,
      skills: [skill],
      skillTargets: [{ id: 'project', label: 'Project' }],
      skillManagementMessage: 'Ready to review',
      skillPreview: {
        id: 'token',
        targetId: 'project',
        action: 'update',
        name: 'example',
        source: 'Reviewed source',
        revision: 'revision',
        files: [],
      },
    };
    const glyph = {
      state,
      refreshSkills: vi.fn(async () => {}),
      previewSkill: vi.fn(async () => {}),
      applySkill: vi.fn(async () => {}),
      discardSkillPreview: vi.fn(async () => {}),
      setSkillEnabled: vi.fn(async () => {}),
      onDidChangeState: (listener: () => void) => {
        changed = listener;
        return { dispose: vi.fn() };
      },
    };
    const dialogs = {
      showOpenDialog: vi.fn<() => Promise<URI[] | undefined>>(async () => [URI.file('/selected/example')]),
    };
    const page = new GlyphSkillsPreferences(glyph as never, { error: vi.fn() } as never, dialogs as never);
    document.body.append(page.getDomNode());
    const ui = within(page.getDomNode());
    try {
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Apply update' }));
      });
      await vi.waitFor(() => {
        expect(glyph.applySkill).toHaveBeenCalledWith('token');
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Discard preview' }));
      });
      await vi.waitFor(() => {
        expect(glyph.discardSkillPreview).toHaveBeenCalledWith('token');
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Install local package' }));
      });
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('project', {
          source: { kind: 'local', path: '/selected/example' },
        });
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Update', exact: true }));
      });
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('project', {
          source: { kind: 'local', path: '/selected/example' },
          replaceId: skill.id,
        });
      });
      dialogs.showOpenDialog.mockResolvedValueOnce(undefined);
      const previous = glyph.previewSkill.mock.calls.length;
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Install local package' }));
      });
      await vi.waitFor(() => {
        expect(dialogs.showOpenDialog).toHaveBeenCalledTimes(3);
      });
      expect(glyph.previewSkill).toHaveBeenCalledTimes(previous);
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Disable', exact: true }));
      });
      await vi.waitFor(() => {
        expect(glyph.setSkillEnabled).toHaveBeenCalledWith(skill.id, false);
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Uninstall' }));
      });
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('', { removeId: skill.id });
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Create skill' }));
      });
      fireEvent.input(ui.getByLabelText('Name', { exact: true }), { target: { value: 'created' } });
      fireEvent.input(ui.getByLabelText('Description', { exact: true }), { target: { value: 'Description' } });
      fireEvent.input(ui.getByLabelText('Instructions'), { target: { value: 'Body' } });
      fireEvent.submit(ui.getByRole('button', { name: 'Preview package' }).closest('form')!);
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('project', {
          draft: expect.objectContaining({ name: 'created' }),
        });
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Update from repository' }));
      });
      fireEvent.input(ui.getByLabelText('Repository URL'), { target: { value: 'https://example.test/skills.git' } });
      fireEvent.input(ui.getByLabelText('Revision', { exact: true }), { target: { value: 'v2' } });
      fireEvent.submit(ui.getByRole('button', { name: 'Preview package' }).closest('form')!);
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('project', {
          source: { kind: 'repository', url: 'https://example.test/skills.git', revision: 'v2', directory: '' },
          replaceId: skill.id,
        });
      });
      await act(async () => {
        fireEvent.click(ui.getByRole('button', { name: 'Install from repository' }));
      });
      fireEvent.submit(ui.getByRole('button', { name: 'Preview package' }).closest('form')!);
      await vi.waitFor(() => {
        expect(glyph.previewSkill).toHaveBeenCalledWith('project', {
          source: { kind: 'repository', url: 'https://example.test/skills.git', revision: 'v2', directory: '' },
        });
      });
      state.readOnly = true;
      state.skills = undefined;
      await act(async () => {
        changed?.();
      });
      expect(ui.queryByRole('button', { name: 'Create skill' })).toBeNull();
    } finally {
      page.dispose();
      page.getDomNode().remove();
    }
  });
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
      { showOpenDialog: vi.fn(async () => []) } as never,
    );
    expect(refreshSkills).toHaveBeenCalledOnce();
    page.layout({ width: 900, height: 600 });
    expect(page.getDomNode().style.height).toBe('600px');
    page.getDomNode().querySelector<HTMLButtonElement>('button[aria-label^="Edit "]')!.click();
    expect(openLink).toHaveBeenCalledExactlyOnceWith('glyph-skill:project%3Aexample');
    openLink.mockRejectedValueOnce(new Error('Skill removed.'));
    page.getDomNode().querySelector<HTMLButtonElement>('button[aria-label^="Edit "]')!.click();
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
