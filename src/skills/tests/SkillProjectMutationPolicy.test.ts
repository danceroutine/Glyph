import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { EnvironmentConfigurationProvider } from '#src/configuration/EnvironmentConfigurationProvider.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ProjectToolName } from '#src/project/ProjectToolName.js';
import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
import { SkillProjectMutationPolicy } from '#src/skills/SkillProjectMutationPolicy.js';
import { aSkillDescriptor } from './fixtures/aSkillDescriptor.ts';
import { aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

describe(SkillProjectMutationPolicy, () => {
  it('covers child packages, compatibility roots and each installed package ancestor with filesystem-specific casing', () => {
    const catalog = {
      skills: [
        aSkillDescriptor({ uri: 'file:///repo/service/module/.cursor/skills/example/SKILL.md' }),
        aSkillDescriptor({ uri: 'file:///RepoSensitive/Other/.glyph/skills/EXAMPLE/SKILL.md' }),
        aSkillDescriptor({ uri: 'file:///RepoSensitive/SKILL.md' }),
        aSkillDescriptor({ uri: 'file:///unrelated/SKILL.md' }),
        aSkillDescriptor({ uri: '' }),
      ],
    };
    const guard = new SkillProjectMutationPolicy(
      [
        { store: { root: '/Repo', caseSensitive: false }, directory: '.glyph/skills' },
        { store: { root: '/RepoSensitive', caseSensitive: true }, directory: '.glyph/skills' },
        { store: { root: '/profiles/Person', caseSensitive: true }, directory: 'skills' },
      ],
      catalog,
    );
    for (const path of [
      '/repo/service',
      '/repo/service/module',
      '/RepoSensitive/Other',
      '/repo/new/.glyph',
      '/repo/new/.cursor/skills/uninstalled/new.json',
      '/repo/.glyph/skills',
      '/profiles/Person/skills',
      '/profiles/Person/skills/example/SKILL.md',
      '/profiles/Person',
    ]) {
      expect(guard.getDenial(path), path).toContain('skills.propose_change');
    }
    for (const path of [
      '/RepoSensitive/other',
      '/RepoSensitive/.GLYPH/SKILLS/a',
      '/profiles/person/skills/new',
      '/repo/service/neighbor.ts',
      '/repo/new/.cursor/rules/rule.mdc',
      '/repo/new/.glyph/skillset/a',
      '/unrelated',
    ]) {
      expect(guard.getDenial(path), path).toBeUndefined();
    }
    catalog.skills = [];
    expect(guard.getDenial('/repo/service')).toBeUndefined();
    expect(guard.getDenial('/profiles')).toContain('skills.propose_change');
  });

  it('separates a native-admitted filename from the case-folded mutation collision key', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-verified-ordinary-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.GLYPH/SKILLS/example'), { recursive: true });
    const ordinary = '.GLYPH/SKILLS/example/notes.md';
    await writeFile(join(root, ordinary), 'ordinary');
    await mkdir(join(root, 'project/inner/.glyph/skills/catalogued'), { recursive: true });
    const manifest = join(root, 'project/inner/.glyph/skills/catalogued/SKILL.md');
    await writeFile(manifest, 'fixture');
    const catalog = {
      skills: [aSkillDescriptor({ uri: '' }), aSkillDescriptor({ uri: pathToFileURL(manifest).href })],
    };
    const guard = new SkillProjectMutationPolicy([], catalog);
    const workspace = fixtureWorkspace(root, {
      physicalAccess: { assertWorkspacePath: async () => {} },
      managedDirectories: [],
      caseSensitive: false,
    });
    const checked = vi.fn();
    const canonical = await workspace.canonicalPath(ordinary, true, checked);
    expect(canonical).toBe(join(root, ordinary).toLowerCase());
    expect(checked).toHaveBeenCalledWith(join(root, ordinary));
    expect(guard.getDenial(canonical, checked.mock.calls[0]![0])).toBeUndefined();
    const unchecked = vi.fn();
    await workspace.canonicalPath(ordinary, false, unchecked);
    expect(unchecked).not.toHaveBeenCalled();
    const project = join(root, 'project');
    expect(guard.getDenial(project, project)).toContain('skills.propose_change');
    const sibling = join(root, 'standalone');
    await mkdir(sibling);
    expect(guard.getDenial(sibling, sibling)).toBeUndefined();
    expect(new SkillProjectMutationPolicy().getDenial(sibling, sibling)).toBeUndefined();
    expect(guard.getDenial(sibling + '/future', sibling + '/future')).toBeUndefined();

    const stage = vi.fn();
    const runtime = new ProjectToolRuntime(
      {} as ProjectAccess,
      new EditProposalService(workspace, new JsDiffTextDiffer(), new EnvironmentConfigurationProvider({}).editing),
      { stage, activeReviews: [] } as unknown as ProposalReviewManager,
      undefined,
      undefined,
      guard,
    );
    const patch = ['*** Begin Patch', '*** Add File: .GLYPH/SKILLS/ordinary.md', '+ordinary', '*** End Patch'].join(
      '\n',
    );
    expect(JSON.parse(await runtime.execute(ProjectToolName.PROPOSE_PATCH, patch))).toMatchObject({
      status: 'STAGED_FOR_REVIEW',
    });
    expect(stage).toHaveBeenCalledOnce();
  });

  it('handles an empty location list and a catalog nested below a filesystem root', () => {
    expect(new SkillProjectMutationPolicy().getDenial('/folder/file.txt')).toBeUndefined();
    const catalog = { skills: [aSkillDescriptor({ uri: 'file:///workspace/service/.glyph/skills/example/SKILL.md' })] };
    const policy = new SkillProjectMutationPolicy(
      [{ store: { root: '/', caseSensitive: true }, directory: 'skills' }],
      catalog,
    );
    expect(policy.getDenial('/workspace/service')).toContain('skills.propose_change');
  });

  it('exposes the installer policy for the configured user directory and its catalog', async () => {
    const { store, manager, install } = await aSkillLifecycle();
    const installed = await install();
    expect(manager.projectMutationPolicy.getDenial(await store.canonicalPath(installed.path))).toContain(
      'skills.propose_change',
    );
    expect(manager.projectMutationPolicy.getDenial(await store.canonicalPath('ordinary.md'))).toBeUndefined();
  });

  it('denies both project proposal formats before loading any file or staging part of a batch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'skill-proposal-boundary-')));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    const packagePath = 'service/.cursor/skills/example/SKILL.md';
    await mkdir(join(root, 'service/.cursor/skills/example'), { recursive: true });
    await writeFile(join(root, packagePath), 'existing');
    await writeFile(join(root, 'neighbor.md'), 'existing');
    const workspace = fixtureWorkspace(root, { caseSensitive: false });
    const catalog = { skills: [aSkillDescriptor({ uri: pathToFileURL(join(root, packagePath)).href })] };
    const guard = new SkillProjectMutationPolicy([{ store: workspace, directory: '.glyph/skills' }], catalog);
    const stage = vi.fn();
    const runtime = new ProjectToolRuntime(
      {} as ProjectAccess,
      new EditProposalService(workspace, new JsDiffTextDiffer(), new EnvironmentConfigurationProvider({}).editing),
      { stage, activeReviews: [] } as unknown as ProposalReviewManager,
      undefined,
      undefined,
      guard,
    );
    const read = vi.spyOn(workspace, 'readOptional');
    const file = (operation: string, path: string, target: string | null = null) => ({
      operation,
      path,
      new_path: target,
      base_revision: operation === 'CREATE' ? null : 'current',
      content: operation === 'CREATE' ? 'new' : null,
      byte_order_mark: false,
      edits: [],
    });
    const newPath = 'service/.GLYPH/SKILLS/new/SKILL.md';
    const patches = [
      ['*** Add File: ' + newPath, '+new'],
      ['*** Delete File: ' + packagePath, '*** Revision: current'],
      ['*** Update File: ' + packagePath, '*** Revision: current', '@@', '-existing', '+replacement'],
      ['*** Update File: neighbor.md', '*** Move to: ' + newPath, '*** Revision: current', '@@', '-existing', '+moved'],
      [
        '*** Update File: ' + packagePath,
        '*** Move to: moved.md',
        '*** Revision: current',
        '@@',
        '-existing',
        '+moved',
      ],
    ];
    for (const lines of patches) {
      const patch = ['*** Begin Patch', '*** Add File: ok.md', '+ok', ...lines, '*** End Patch'].join('\n');
      expect(JSON.parse(await runtime.execute(ProjectToolName.PROPOSE_PATCH, patch))).toMatchObject({
        error: { code: 'UNSUPPORTED', message: expect.stringContaining('skills.propose_change') },
      });
    }
    for (const entry of [
      file('CREATE', newPath),
      file('DELETE', packagePath),
      file('UPDATE', packagePath),
      file('RENAME', 'neighbor.md', newPath),
      file('RENAME', packagePath, 'moved.md'),
      file('DELETE', 'service'),
    ]) {
      const edits = JSON.stringify({ files: [file('CREATE', 'ok.md'), entry] });
      expect(JSON.parse(await runtime.execute(ProjectToolName.PROPOSE_EDITS, edits))).toMatchObject({
        error: { code: 'UNSUPPORTED', message: expect.stringContaining('skills.propose_change') },
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    const permitted = JSON.stringify({ files: [file('CREATE', 'service/.cursor/rules/neighbor.mdc')] });
    expect(JSON.parse(await runtime.execute(ProjectToolName.PROPOSE_EDITS, permitted))).toMatchObject({
      status: 'STAGED_FOR_REVIEW',
    });
    expect(stage).toHaveBeenCalledOnce();
  });
});
