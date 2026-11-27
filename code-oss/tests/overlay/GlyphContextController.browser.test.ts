import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GlyphContextController } from '#vs/workbench/contrib/glyph/browser/GlyphContextController.js';
import { URI } from '#vs/base/common/uri.js';
import { Emitter } from '#vs/base/common/event.js';
import { Selection } from '#vs/editor/common/core/selection.js';
import { EditorType } from '#vs/editor/common/editorCommon.js';
import { QueryType } from '#vs/workbench/services/search/common/search.js';
import { formatFolderContextOutline } from '#glyph/workbench/formatFolderContextOutline.js';
import { GlyphContextCandidateKind } from '#glyph/workbench/GlyphContextActions.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphTextRange } from '#glyph/protocol/connection/GlyphTextRange.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

interface Folder {
  name: string;
  uri: URI;
}

interface Stat {
  isFile?: boolean;
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  children?: { resource: URI; isDirectory: boolean; isSymbolicLink: boolean }[];
}

function codeEditor(model: { uri: URI } | null, selections: Selection[] | null = [new Selection(1, 1, 1, 5)]) {
  const focus = new Emitter<void>();
  return {
    getEditorType: () => EditorType.ICodeEditor,
    getModel: () => model,
    getSelections: () => selections,
    onDidFocusEditorText: focus.event,
    focus: () => {
      focus.fire();
    },
  };
}

function diffEditor(original: ReturnType<typeof codeEditor>, modified: ReturnType<typeof codeEditor>) {
  return {
    getEditorType: () => EditorType.IDiffEditor,
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified,
  };
}

function controllerServices() {
  const folders: Folder[] = [{ name: 'workspace', uri: URI.file('/workspace') }];
  const models: { uri: URI }[] = [];
  const stats = new Map<string, Stat>();
  const fileChanges = new Emitter<readonly { resource: URI; type: number }[]>();
  const registrations = new Emitter<{ scheme: string }>();
  const modelAdded = new Emitter<{ uri: URI }>();
  const modelRemoved = new Emitter<{ uri: URI }>();
  const editorAdded = new Emitter<ReturnType<typeof codeEditor>>();
  const folderOf = (uri: URI) =>
    folders.find(folder => uri.path === folder.uri.path || uri.path.startsWith(`${folder.uri.path}/`));
  const contextPath = vi.fn((uri: URI) => {
    if (uri.scheme === 'untitled') return uri.path.replace(/^\//u, '');
    const folder = uri.scheme === 'file' ? folderOf(uri) : undefined;
    if (!folder) throw new Error('Outside of the workspace');
    const path = uri.path.slice(folder.uri.path.length + 1);
    return folders.length > 1 ? `${folder.name}/${path}` : path;
  });
  const composer = { insertAttachments: vi.fn((_attachments: { side?: string }[]) => undefined) };
  const services = {
    folders,
    fileChanges,
    registrations,
    modelAdded,
    modelRemoved,
    models,
    stats,
    editorAdded,
    composer,
    instructionSources: [] as {
      id: string;
      path: string;
      activation?: string;
      status: string;
      enabled?: boolean;
      name?: string;
      description?: string;
      uri?: string;
      revision?: string;
      managementRevision?: string;
      caseSensitive?: boolean;
      references?: readonly string[];
      referenceResources?: readonly { uri: string; caseSensitive: boolean }[];
      uri?: string;
      kind?: string;
    }[],
    codeEditorList: [] as ReturnType<typeof codeEditor>[],
    adapter: {
      contextPath,
      isCurrentContext: vi.fn(() => true),
      captureContext: vi.fn(async (model: { uri: URI }, range?: GlyphTextRange): Promise<GlyphContextAttachment> => ({
        id: 'capture',
        kind: range ? GlyphContextAttachmentKind.SELECTION : GlyphContextAttachmentKind.FILE,
        uri: model.uri.toString(),
        path: contextPath(model.uri),
        text: 'text',
        contentRevision: 'revision',
        ...(range ? { range } : {}),
      })),
    },
    ide: {
      select: vi.fn(async () => []),
      captureTestSelection: vi.fn(async (_model: unknown, selection: Selection) => ({
        id: 'test',
        kind: GlyphContextAttachmentKind.TEST,
        uri: 'vscode-test-data://results/run/output/0',
        path: `Test output ${selection.startLineNumber}`,
        text: 'output',
        contentRevision: 'revision',
      })),
      openSource: vi.fn(async () => false),
    },
    editors: {
      activeTextEditorControl: undefined as unknown,
      openEditor: vi.fn(async (_input: { resource: URI; options?: unknown }) => undefined),
    },
    modelService: {
      onModelAdded: modelAdded.event,
      onModelRemoved: modelRemoved.event,
      getModels: () => models,
      getModel: (uri: URI) => models.find(model => model.uri.toString() === uri.toString()) ?? null,
    },
    resolver: {
      createModelReference: vi.fn(async (uri: URI) => ({ object: { textEditorModel: { uri } }, dispose: vi.fn() })),
    },
    workspace: {
      getWorkspace: () => ({ folders }),
      getWorkspaceFolder: vi.fn((uri: URI): Folder | null => folderOf(uri) ?? null),
      isInsideWorkspace: (uri: URI) => folderOf(uri) !== undefined,
    },
    trust: { isWorkspaceTrusted: vi.fn(() => true) },
    search: {
      fileSearch: vi.fn(async (): Promise<{ results: { resource: URI }[]; limitHit?: boolean }> => ({ results: [] })),
    },
    files: {
      realpath: vi.fn(async (uri: URI): Promise<URI | undefined> => uri),
      hasCapability: vi.fn(() => true),
      getProvider: vi.fn(() => ({ onDidChangeFile: fileChanges.event })),
      onDidChangeFileSystemProviderRegistrations: registrations.event,
      watch: vi.fn(() => ({ dispose: vi.fn() })),
      resolve: vi.fn(async (uri: URI): Promise<Stat> => stats.get(uri.path) ?? { children: [] }),
      stat: vi.fn(async (uri: URI): Promise<Stat> => stats.get(uri.path) ?? { isDirectory: false, size: 4 }),
      exists: vi.fn(async (_uri: URI) => true),
    },
    dialogs: { showOpenDialog: vi.fn(async (): Promise<URI[] | undefined> => undefined) },
    commands: { executeCommand: vi.fn(async () => undefined) },
  };
  return services;
}

type ControllerServices = ReturnType<typeof controllerServices>;

function createController(services: ControllerServices) {
  return new GlyphContextController(
    services.adapter as never,
    () => services.composer as never,
    () => services.instructionSources as never,
    services.editors as never,
    { listCodeEditors: () => services.codeEditorList, onCodeEditorAdd: services.editorAdded.event } as never,
    services.modelService as never,
    services.resolver as never,
    services.workspace as never,
    services.trust as never,
    services.search as never,
    services.files as never,
    services.dialogs as never,
    services.commands as never,
    { createInstance: () => services.ide } as never,
  );
}

describe(GlyphContextController, () => {
  it.each([GlyphContextAttachmentKind.SKILL, GlyphContextAttachmentKind.RULE])(
    'treats %s badges as live references during refresh, open, and rebind',
    async kind => {
      const services = controllerServices();
      const source = {
        id: 'reference',
        kind: 'glyph_project_rule',
        activation: 'manual',
        path: '.glyph/skills/example/SKILL.md',
        directory: '.glyph/skills/example',
        name: 'example',
        description: 'Examples',
        origin: { id: 'project', label: 'Project', scope: 'project' as const, compatibility: 'glyph' },
        scope: '.',
        status: 'active' as 'active' | 'error',
        enabled: true,
        allowedTools: [],
        revision: 'one',
        uri: 'file:///workspace/.glyph/skills/example/SKILL.md',
      };
      const controller = createController(services);
      const sources = [source];
      controller.setSkillSources(() => sources);
      services.instructionSources.push(source);
      const uri = kind === GlyphContextAttachmentKind.SKILL ? 'glyph-skill:reference' : 'glyph-rule:reference';
      const badge: GlyphContextAttachment = { kind, uri, path: 'example', text: '', contentRevision: 'one' };
      expect(await controller.checkAttachment(badge)).toBeUndefined();
      source.revision = 'two';
      expect(await controller.checkAttachment(badge)).toContain('latest version');
      expect(await controller.refreshAttachment({ ...badge, unavailable: 'Old binding' })).toMatchObject({
        contentRevision: 'two',
      });
      expect(controller.rebindAttachment({ ...badge, unavailable: 'Old binding' }).unavailable).toBeUndefined();
      services.files.stat.mockImplementation(async resource => ({
        isFile: resource.path.endsWith('SKILL.md'),
        isDirectory: !resource.path.endsWith('SKILL.md'),
      }));
      if (kind === GlyphContextAttachmentKind.SKILL) {
        const resolveOld = vi.fn(async (id: string, manifestUri?: string) =>
          id === 'old' || (id === source.id && manifestUri === source.uri) ? source.id : undefined,
        );
        controller.setSkillSources(() => sources, undefined, resolveOld);
        const old = { ...badge, uri: 'glyph-skill:old', skillId: 'old' };
        expect(await controller.checkAttachment(old)).toContain('latest version');
        expect(await controller.refreshAttachment(old)).toMatchObject({
          uri,
          skillId: source.id,
          contentRevision: 'two',
        });
        await controller.openAttachment(old);
        expect(services.editors.openEditor.mock.calls.at(-1)?.[0].resource.toString()).toBe(source.uri);
        source.enabled = false;
        await controller.openAttachment(old);
        expect(await controller.checkAttachment(old)).toContain('unavailable');
        source.enabled = true;
        source.status = 'error';
        expect(await controller.checkAttachment(old)).toContain('unavailable');
        source.status = 'active';
        expect(await controller.checkAttachment({ ...old, uri: 'glyph-skill:absent' })).toContain('unavailable');
        resolveOld.mockImplementationOnce(async () => {
          services.trust.isWorkspaceTrusted.mockReturnValue(false);
          return source.id;
        });
        await expect(controller.refreshAttachment(old)).rejects.toThrow(/trust/iu);
        services.trust.isWorkspaceTrusted.mockReturnValue(true);
        const { revision: _revision, ...unversioned } = source;
        controller.setSkillSources(() => [unversioned]);
        expect((await controller.refreshAttachment(badge)).contentRevision).toBe(source.id);
        controller.setSkillSources(() => sources, undefined, resolveOld);
      }
      await controller.openAttachment(badge);
      expect(services.editors.openEditor.mock.calls.at(-1)?.[0].resource.toString()).toBe(source.uri);
      expect(services.editors.openEditor).toHaveBeenCalledWith(expect.objectContaining({ options: { pinned: true } }));
      source.enabled = false;
      expect(await controller.checkAttachment(badge)).toContain('unavailable');
      await expect(controller.refreshAttachment(badge)).rejects.toThrow('unavailable');
      source.enabled = true;
      source.status = 'error';
      await expect(controller.refreshAttachment(badge)).rejects.toThrow('unavailable');
      sources.splice(0);
      services.instructionSources.splice(0);
      await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
      expect(await controller.checkAttachment({ ...badge, uri: 'file:///not-a-reference' })).toContain('unavailable');
      controller.dispose();
    },
  );

  it('refreshes skill metadata before searching the slash catalog', async () => {
    const services = controllerServices();
    const controller = createController(services);
    let sources: readonly GlyphSkill[] = [];
    const refresh = vi.fn(async () => {
      sources = [
        {
          id: 'new-skill',
          name: 'new-skill',
          description: 'Newly repaired workflow',
          revision: 'repaired-r1',
          path: '.glyph/skills/new-skill/SKILL.md',
          directory: '.glyph/skills/new-skill',
          scope: '.',
          origin: { id: 'project', label: 'Project', scope: 'project', compatibility: 'glyph' },
          enabled: true,
          status: 'active',
          allowedTools: [],
          uri: 'file:///workspace/.glyph/skills/new-skill/SKILL.md',
        },
      ];
    });
    controller.setSkillSources(() => sources, refresh);
    expect(await controller.searchInstructions('repaired')).toMatchObject([
      { skillId: 'new-skill', revision: 'repaired-r1' },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    services.trust.isWorkspaceTrusted.mockReturnValue(false);
    await expect(controller.searchInstructions('repaired')).rejects.toThrow();
    expect(refresh).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('ranks names across skills and manual rules before limiting the slash picker', async () => {
    const services = controllerServices();
    for (let index = 0; index < 51; index++)
      services.instructionSources.push({
        id: String(index),
        name: 'build' + index,
        description: 'release workflow',
        path: 'build' + index,
        activation: 'manual',
        status: 'active',
      });
    for (const name of ['pre-release', 'release-notes', 'release'])
      services.instructionSources.push({ id: name, name, path: name, activation: 'manual', status: 'active' });
    const controller = createController(services);
    controller.setSkillSources(() => [
      {
        id: 'skill',
        uri: 'file:///skills/release/SKILL.md',
        name: 'Release',
        description: 'publish',
        path: 'skills/release/SKILL.md',
        directory: 'skills/release',
        scope: '.',
        origin: { id: 'p', label: 'Project', scope: 'project', compatibility: 'glyph' },
        status: 'active',
        enabled: true,
        allowedTools: [],
      },
    ]);
    const matches = await controller.searchInstructions('RELEASE');
    expect(matches).toHaveLength(50);
    expect(matches.slice(0, 5).map(item => item.ruleId ?? item.skillId)).toEqual([
      'release',
      'skill',
      'release-notes',
      'pre-release',
      '0',
    ]);
    controller.dispose();
  });

  it('looks up the current skill identity and rejects unavailable, removed or linked editor targets', async () => {
    const services = controllerServices();
    const controller = createController(services);
    const packageA = {
      id: 'api',
      name: 'task',
      description: 'Workflow',
      scope: 'api',
      directory: 'api/.glyph/skills/task',
      path: 'api/.glyph/skills/task/SKILL.md',
      uri: 'file:///workspace/api/.glyph/skills/task/SKILL.md',
      origin: { id: 'project', label: 'Project', scope: 'project' as const, compatibility: 'glyph' },
      status: 'active' as const,
      enabled: true,
      allowedTools: [],
    };
    const packageB = { ...packageA, id: 'web', scope: 'web', path: 'web/.glyph/skills/task/SKILL.md' };
    let sources: readonly GlyphSkill[] = [packageA, packageB];
    const refresh = vi.fn(async () => {});
    controller.setSkillSources(() => sources, refresh);
    expect(
      (await controller.searchInstructions('api')).map(candidate => [candidate.skillId, candidate.detail]),
    ).toEqual([['api', `${packageA.path} · Project · Workflow`]]);
    expect((await controller.searchInstructions('task')).map(candidate => candidate.detail)).toEqual([
      `${packageA.path} · Project · Workflow`,
      `${packageB.path} · Project · Workflow`,
    ]);
    expect((await controller.searchInstructions('web'))[0]?.ancestry).toEqual(['Project', ...packageB.path.split('/')]);
    const badge = { uri: 'glyph-skill:api', path: 'task' };
    refresh.mockImplementationOnce(async () => {
      sources = [{ ...packageA, uri: '', status: 'error' }];
    });
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    expect(services.files.stat).not.toHaveBeenCalled();
    sources = [packageA];
    services.files.stat.mockImplementation(async uri => ({
      isFile: uri.path.endsWith('SKILL.md'),
      isDirectory: !uri.path.endsWith('SKILL.md'),
      isSymbolicLink: uri.path.endsWith('/task'),
    }));
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    sources = [{ ...packageA, uri: 'https://example.com/SKILL.md' }];
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    sources = [packageA];
    services.files.stat.mockResolvedValueOnce({ isDirectory: true, isFile: false });
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    services.files.stat.mockImplementation(async uri => {
      sources = [{ ...packageA, uri: 'file:///other/package/SKILL.md' }];
      return { isFile: uri.path.endsWith('SKILL.md'), isDirectory: !uri.path.endsWith('SKILL.md') };
    });
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    refresh.mockImplementationOnce(async () => {
      sources = [];
    });
    await expect(controller.openAttachment(badge)).rejects.toThrow('unavailable');
    expect(services.editors.openEditor).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('opens user skills at their authorized URI and routes project references in multi-root workspaces', async () => {
    const services = controllerServices();
    const controller = createController(services);
    services.folders.push({ name: 'subproject', uri: URI.file('/sub') });
    const skill = {
      id: 'example',
      name: 'example',
      description: 'fixture',
      directory: '.glyph/skills/example',
      path: '.glyph/skills/example/SKILL.md',
      scope: 'subproject',
      uri: 'file:///sub/.glyph/skills/example/SKILL.md',
      status: 'active' as const,
      enabled: true,
      allowedTools: [],
      origin: { id: 'project', label: 'Project', scope: 'project' as const, compatibility: 'glyph' },
    };
    const admit = vi.fn(async (id: string, _resource?: string): Promise<string | undefined> => id);
    controller.setSkillSources(() => [skill], undefined, admit);
    services.files.stat.mockImplementation(async uri => ({
      isFile: uri.path.endsWith('.md'),
      isDirectory: !uri.path.endsWith('.md'),
    }));
    const attachment = { uri: 'glyph-skill:example', path: 'example' };
    await controller.openAttachment(attachment);
    expect(services.editors.openEditor.mock.calls.at(-1)?.[0]?.resource?.toString()).toBe(skill.uri);
    expect(admit).toHaveBeenCalledWith(skill.id, skill.uri);
    admit.mockResolvedValueOnce(undefined);
    await expect(controller.openAttachment(attachment)).rejects.toThrow('unavailable');
    admit.mockImplementationOnce(async id => {
      services.folders.pop();
      return id;
    });
    await expect(controller.openAttachment(attachment)).rejects.toThrow('unavailable');
    expect(services.editors.openEditor).toHaveBeenCalledTimes(1);
    controller.setSkillSources(
      () => [
        {
          ...skill,
          uri: 'file:///profile/skills/example/SKILL.md',
          path: 'skills/example/SKILL.md',
          origin: { ...skill.origin, scope: 'user' },
        },
      ],
      undefined,
      admit,
    );
    await controller.openAttachment(attachment);
    expect(services.editors.openEditor.mock.calls.at(-1)?.[0]?.resource?.toString()).toBe(
      'file:///profile/skills/example/SKILL.md',
    );
  });

  it('opens workspace rule references without direct URIs and refreshes an unversioned reference by ID', async () => {
    const services = controllerServices();
    services.instructionSources.push({
      id: 'rule',
      kind: 'glyph_project_rule',
      activation: 'manual',
      path: '.glyph/rules/example.mdc',
      status: 'active',
    });
    const controller = createController(services);
    const badge: GlyphContextAttachment = {
      kind: GlyphContextAttachmentKind.RULE,
      uri: 'glyph-rule:rule',
      path: 'Example',
      text: '',
      contentRevision: 'old',
    };
    expect(await controller.checkAttachment(badge)).toBeUndefined();
    expect(await controller.refreshAttachment(badge)).toMatchObject({ path: 'Example', contentRevision: 'rule' });
    services.files.stat.mockImplementation(async resource => ({
      isFile: resource.path.endsWith('.mdc'),
      isDirectory: !resource.path.endsWith('.mdc'),
    }));
    await controller.openAttachment(badge);
    expect(services.editors.openEditor.mock.calls.at(-1)?.[0].resource.toString()).toBe(
      'file:///workspace/.glyph/rules/example.mdc',
    );
    expect(services.editors.openEditor).toHaveBeenCalledWith(expect.objectContaining({ options: { pinned: true } }));
    controller.dispose();
  });

  it.each([
    '/workspace/src/AGENTS.md',
    '/workspace/.glyph/rules/new.mdc',
    '/workspace/.cursor/rules/new.mdc',
    '/workspace/reference.md',
    '/custom/references/note.md',
    '/workspace/pkg/.glyph/skills/new/SKILL.md',
    '/workspace/.cursor/skills/new/SKILL.md',
    '/custom/skills/new/SKILL.md',
  ])('refreshes instruction discovery after a relevant file or dirty-model change at %s', async path => {
    vi.useFakeTimers();
    const services = controllerServices();
    services.instructionSources.push(
      {
        id: 'project',
        status: 'active',
        path: '.glyph/rules/project.mdc',
        uri: 'file:///workspace/.glyph/rules/project.mdc',
        references: ['reference.md'],
      },
      {
        id: 'user',
        kind: 'glyph_user_rule',
        status: 'active',
        path: '~/.glyph/rules/user.mdc',
        uri: 'file:///custom/rules/user.mdc',
        references: ['references/note.md'],
      },
    );
    const edits = new Emitter<void>();
    const model = { uri: URI.file(path), onDidChangeContent: edits.event };
    services.models.push(model);
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    try {
      controller.setInstructionRefresh(refresh, () => ['file:///custom/rules', 'file:///custom/skills']);
      controller.notifyInstructionsChanged();
      expect(services.files.watch).toHaveBeenCalledWith(URI.file('/custom/references/note.md'), {
        recursive: false,
        excludes: [],
      });
      services.fileChanges.fire([{ resource: model.uri, type: 1 }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(refresh).toHaveBeenCalledOnce();
      edits.fire();
      await vi.advanceTimersByTimeAsync(300);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('stops scheduling refreshes when an open model loses its last rule reference', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const edits = new Emitter<void>();
    const uri = URI.file('/workspace/former-reference.md');
    services.models.push({ uri, onDidChangeContent: edits.event } as never);
    services.instructionSources.push({
      id: 'project',
      path: '.glyph/rules/old.mdc',
      status: 'active',
      referenceResources: [{ uri: uri.toString(), caseSensitive: true }],
    });
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    try {
      controller.setInstructionRefresh(refresh);
      controller.notifyInstructionsChanged();
      services.instructionSources.length = 0;
      controller.notifyInstructionsChanged();
      edits.fire();
      await vi.advanceTimersByTimeAsync(1500);
      expect(refresh).not.toHaveBeenCalled();
      services.instructionSources.push({
        id: 'new',
        path: '.glyph/rules/new.mdc',
        status: 'active',
        referenceResources: [{ uri: uri.toString(), caseSensitive: true }],
      });
      controller.notifyInstructionsChanged();
      services.modelRemoved.fire(services.models[0]);
      edits.fire();
      await vi.advanceTimersByTimeAsync(1500);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('watches profile skill enablement on disk and in dirty models', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    const edits = new Emitter<void>();
    const uri = URI.file('/profile/.glyph/skill-state.json');
    services.models.push({ uri, onDidChangeContent: edits.event } as never);
    try {
      controller.setInstructionRefresh(refresh, () => [uri.toString()]);
      controller.notifyInstructionsChanged();
      expect(services.files.watch).toHaveBeenCalledWith(expect.objectContaining({ path: uri.path }), {
        recursive: false,
        excludes: [],
      });
      services.fileChanges.fire([{ resource: uri, type: 1 }]);
      await vi.advanceTimersByTimeAsync(1300);
      edits.fire();
      await vi.advanceTimersByTimeAsync(1300);
      expect(refresh.mock.calls).toEqual([[true], [true], [true], [true]]);
    } finally {
      controller.dispose();
      edits.dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes a repaired reference through its attached nested alias or physical URI', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    try {
      services.instructionSources.push({
        id: 'rule',
        path: 'Outer/.glyph/rules/r.mdc',
        status: 'error',
        references: ['Outer/sub/shared.md'],
        referenceResources: [
          { uri: 'file:///alias/shared.md', caseSensitive: false },
          { uri: 'file:///volume/sub/shared.md', caseSensitive: true },
        ],
      });
      controller.setInstructionRefresh(refresh);
      controller.notifyInstructionsChanged();
      for (const path of ['/alias/SHARED.md', '/volume/sub/shared.md']) {
        services.fileChanges.fire([{ resource: URI.file(path), type: 1 }]);
        await vi.advanceTimersByTimeAsync(1300);
      }
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(services.files.watch).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('observes differently cased reference creations on insensitive roots without conflating root IDs', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    try {
      services.instructionSources.push({
        id: 'rule',
        kind: 'glyph_project_rule',
        path: '.glyph/rules/r.mdc',
        status: 'error',
        references: ['docs/missing.md'],
      });
      controller.setInstructionRefresh(refresh);
      const changed = async (path: string) => {
        services.fileChanges.fire([{ resource: URI.file(path), type: 1 }]);
        await vi.advanceTimersByTimeAsync(1300);
      };
      await changed('/workspace/docs/MISSING.md');
      expect(refresh).not.toHaveBeenCalled();
      services.files.hasCapability.mockReturnValue(false);
      await changed('/workspace/docs/MISSING.md');
      expect(refresh).toHaveBeenCalledTimes(2);
      refresh.mockClear();
      services.folders.push({ name: 'Workspace', uri: URI.file('/other') });
      services.instructionSources[0].references = ['Workspace/docs/missing.md'];
      await changed('/workspace/docs/MISSING.md');
      expect(refresh).not.toHaveBeenCalled();
      await changed('/other/docs/MISSING.md');
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps watching after an invalidated catalog or its delayed follow-up fails', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const controller = createController(services);
    const refresh = vi.fn().mockRejectedValue(new Error('Catalog not ready'));
    try {
      controller.setInstructionRefresh(refresh);
      services.fileChanges.fire([{ resource: URI.file('/workspace/AGENTS.md'), type: 1 }]);
      await vi.advanceTimersByTimeAsync(1300);
      expect(refresh.mock.calls).toEqual([[true], [true]]);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('reconciles trusted user watch roots and notifies slash search once per catalog change', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    const changed = vi.fn();
    const disposeWatch = vi.fn();
    services.files.watch.mockReturnValueOnce({ dispose: disposeWatch });
    const unsubscribe = controller.onDidChangeInstructions(changed);
    const source = { id: 'linked', path: 'direct.mdc', status: 'active', uri: 'file:///workspace/direct.mdc' };
    services.instructionSources.push(source, {
      id: 'unknown-location',
      kind: 'glyph_user_rule',
      path: 'user.mdc',
      status: 'active',
      uri: 'file:///other/rules/user.mdc',
      references: ['references/guide.md'],
    });
    try {
      controller.setInstructionRefresh(refresh, () => ['file:///custom/rules']);
      controller.notifyInstructionsChanged();
      controller.notifyInstructionsChanged();
      expect(services.files.watch).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
      services.fileChanges.fire([{ resource: URI.file('/workspace/unrelated.ts'), type: 1 }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(refresh).not.toHaveBeenCalled();
      services.fileChanges.fire([{ resource: URI.parse(source.uri), type: 1 }]);
      await vi.advanceTimersByTimeAsync(1300);
      expect(refresh).toHaveBeenCalledTimes(2);
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      controller.notifyInstructionsChanged();
      expect(disposeWatch).toHaveBeenCalledOnce();
      unsubscribe();
      services.instructionSources.splice(0);
      controller.notifyInstructionsChanged();
      expect(changed).toHaveBeenCalledOnce();
      controller.setInstructionRefresh();
      services.fileChanges.fire([{ resource: URI.file('/workspace/AGENTS.md'), type: 1 }]);
      await vi.advanceTimersByTimeAsync(1300);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes saved and unsaved rule metadata, reconnects provider listeners, and suppresses refresh when trust is lost', async () => {
    vi.useFakeTimers();
    const services = controllerServices();
    const edits = new Emitter<void>();
    const model = { uri: URI.file('/workspace/.glyph/rules/example.mdc'), onDidChangeContent: edits.event };
    services.models.push(model, { uri: URI.file('/workspace/source.ts') });
    const controller = createController(services);
    const refresh = vi.fn(async () => {});
    try {
      controller.notifyInstructionsChanged();
      controller.setInstructionRefresh(refresh);
      controller.notifyInstructionsChanged();
      services.fileChanges.fire([{ resource: URI.file('/workspace/source.ts'), type: 1 }]);
      services.registrations.fire({ scheme: 'git' });
      services.files.getProvider.mockReturnValueOnce(undefined as never);
      services.registrations.fire({ scheme: 'file' });
      services.registrations.fire({ scheme: 'file' });
      services.modelAdded.fire({
        uri: URI.file('/workspace/.cursor/rules/other.mdc'),
        onDidChangeContent: edits.event,
      });
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      edits.fire();
      await vi.advanceTimersByTimeAsync(300);
      expect(refresh).not.toHaveBeenCalled();
      services.trust.isWorkspaceTrusted.mockReturnValue(true);
      edits.fire();
      await vi.advanceTimersByTimeAsync(300);
      expect(refresh).toHaveBeenCalledOnce();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  describe(GlyphContextController.prototype.selectIdeContext, () => {
    it('asks for IDE context from the focused side of a diff editor', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      services.editorAdded.fire(modified);
      await controller.selectIdeContext();
      original.focus();
      await controller.selectIdeContext();
      modified.focus();
      await controller.selectIdeContext();
      expect(services.ide.select.mock.calls).toEqual([[modified], [original], [modified]]);
    });

    it('asks for IDE context without an editor when no text editor is active', async () => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = { getEditorType: () => 'other' };
      await createController(services).selectIdeContext();
      expect(services.ide.select).toHaveBeenCalledWith(undefined);
    });

    it('stops tracking editor focus once disposed', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      controller.dispose();
      original.focus();
      await controller.selectIdeContext();
      expect(services.ide.select).toHaveBeenCalledWith(modified);
    });
  });

  describe(GlyphContextController.prototype.attachSelection, () => {
    it('refuses to attach a selection in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createController(services).attachSelection()).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });

    it.each([
      ['no editor is active', undefined],
      ['the editor has no model', codeEditor(null)],
      ['the editor reports no selections', codeEditor({ uri: URI.file('/workspace/a.ts') }, null)],
      ['every selection is empty', codeEditor({ uri: URI.file('/workspace/a.ts') }, [new Selection(1, 2, 1, 2)])],
    ])('asks for highlighted text when %s', async (_case, control) => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = control;
      await expect(createController(services).attachSelection()).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.INVALID_REQUEST,
        message: 'Highlight text in an editor before attaching a selection.',
      });
    });

    it('attaches selected test output through the IDE context', async () => {
      const services = controllerServices();
      const model = { uri: URI.parse('vscode-test-data://results/run/output/0') };
      services.editors.activeTextEditorControl = codeEditor(model, [
        new Selection(1, 1, 1, 3),
        new Selection(2, 1, 2, 3),
      ]);
      await createController(services).attachSelection();
      expect(services.ide.captureTestSelection).toHaveBeenCalledTimes(2);
      expect(services.composer.insertAttachments).toHaveBeenCalledWith([
        expect.objectContaining({ path: 'Test output 1' }),
        expect.objectContaining({ path: 'Test output 2' }),
      ]);
    });

    it('attaches every highlighted range of a plain editor', async () => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = codeEditor({ uri: URI.file('/workspace/a.ts') }, [
        new Selection(1, 1, 1, 3),
        new Selection(2, 2, 2, 2),
        new Selection(3, 1, 4, 2),
      ]);
      await createController(services).attachSelection();
      expect(services.composer.insertAttachments).toHaveBeenCalledWith([
        expect.objectContaining({ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } } }),
        expect.objectContaining({ range: { start: { line: 3, column: 1 }, end: { line: 4, column: 2 } } }),
      ]);
      expect(services.composer.insertAttachments.mock.calls[0][0][0]).not.toHaveProperty('side');
    });

    it('labels selections with the side of a diff editor they came from', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original, modified);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      original.focus();
      await controller.attachSelection();
      modified.focus();
      await controller.attachSelection();
      expect(services.composer.insertAttachments.mock.calls.map(([[attachment]]) => attachment.side)).toEqual([
        'original',
        'modified',
      ]);
    });
  });

  describe(GlyphContextController.prototype.searchFiles, () => {
    it('refuses to search in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      const controller = createController(services);
      await expect(controller.searchFiles('')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
      await expect(controller.searchInstructions('')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });

    it('offers open files, search results, their folders, and top-level folders', async () => {
      const services = controllerServices();
      services.models.push(
        { uri: URI.file('/workspace/src/deep/a.ts') },
        { uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) },
        { uri: URI.file('/elsewhere/b.ts') },
        { uri: URI.parse('git:/workspace/src/deep/a.ts') },
      );
      services.search.fileSearch.mockResolvedValue({ results: [{ resource: URI.file('/workspace/src/b.ts') }] });
      services.stats.set('/workspace', {
        children: [
          { resource: URI.file('/workspace/lib'), isDirectory: true, isSymbolicLink: false },
          { resource: URI.file('/workspace/link'), isDirectory: true, isSymbolicLink: true },
          { resource: URI.file('/workspace/x.ts'), isDirectory: false, isSymbolicLink: false },
        ],
      });
      expect(await createController(services).searchFiles('')).toEqual([
        {
          uri: 'file:///workspace/src/deep/a.ts',
          path: 'src/deep/a.ts',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['src', 'deep', 'a.ts'],
        },
        {
          uri: 'file:///workspace/src/deep',
          path: 'src/deep/',
          kind: GlyphContextCandidateKind.FOLDER,
          ancestry: ['src', 'deep'],
        },
        { uri: 'file:///workspace/src', path: 'src/', kind: GlyphContextCandidateKind.FOLDER, ancestry: ['src'] },
        {
          uri: 'file:///workspace',
          path: './',
          kind: GlyphContextCandidateKind.FOLDER,
          name: 'workspace',
          ancestry: ['workspace'],
        },
        {
          uri: 'untitled:Untitled-1',
          path: 'Untitled-1',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['Untitled-1'],
        },
        {
          uri: 'file:///workspace/src/b.ts',
          path: 'src/b.ts',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['src', 'b.ts'],
        },
        { uri: 'file:///workspace/lib', path: 'lib/', kind: GlyphContextCandidateKind.FOLDER, ancestry: ['lib'] },
      ]);
      const [[query]] = services.search.fileSearch.mock.calls as unknown as [[{ folderQueries: { folder: URI }[] }]];
      expect({
        ...query,
        folderQueries: query.folderQueries.map(folder => ({ ...folder, folder: folder.folder.toString() })),
      }).toEqual({
        type: QueryType.File,
        folderQueries: [{ folder: 'file:///workspace', ignoreSymlinks: true }],
        filePattern: '',
        maxResults: 50,
      });
    });

    it('filters candidates by the query regardless of case', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/src/Deep/a.ts') });
      expect((await createController(services).searchFiles('deep')).map(candidate => candidate.path)).toEqual([
        'src/Deep/a.ts',
        'src/Deep/',
      ]);
    });

    it('offers only enabled active manual rules with bounded metadata', async () => {
      const services = controllerServices();
      services.instructionSources.push(
        {
          id: 'manual',
          path: '.glyph/rules/typescript.mdc',
          activation: 'manual',
          status: 'active',
          name: 'TypeScript',
          description: 'Strict project types',
          revision: 'one',
        },
        { id: 'path-name', path: '.glyph/rules/accessibility.mdc', activation: 'manual', status: 'active' },
        { id: 'always', path: '.glyph/rules/always.mdc', activation: 'always', status: 'active' },
        { id: 'failed', path: '.glyph/rules/failed.mdc', activation: 'manual', status: 'error' },
        { id: 'disabled', path: '.glyph/rules/disabled.mdc', activation: 'manual', status: 'active', enabled: false },
      );

      const controller = createController(services);
      expect(await controller.searchInstructions('type')).toEqual([
        {
          uri: 'glyph-rule:manual',
          path: 'TypeScript',
          name: 'TypeScript',
          detail: 'Strict project types · .glyph/rules/typescript.mdc',
          kind: GlyphContextCandidateKind.RULE,
          ruleId: 'manual',
          revision: 'one',
        },
      ]);
      expect(await controller.searchInstructions('access')).toEqual([
        {
          uri: 'glyph-rule:path-name',
          path: 'accessibility.mdc',
          name: 'accessibility.mdc',
          detail: '.glyph/rules/accessibility.mdc',
          kind: GlyphContextCandidateKind.RULE,
          ruleId: 'path-name',
        },
      ]);
      expect(await controller.searchInstructions('missing')).toEqual([]);
      expect(services.search.fileSearch).not.toHaveBeenCalled();
    });

    it('searches only the root named by the query in a multi-root workspace', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
      services.search.fileSearch.mockResolvedValue({ results: [{ resource: URI.file('/two/b.ts') }] });
      const controller = createController(services);
      expect((await controller.searchFiles('two/b')).map(candidate => candidate.path)).toEqual(['two/b.ts']);
      await controller.searchFiles('b');
      const queries = services.search.fileSearch.mock.calls as unknown as [
        { folderQueries: { folder: URI }[]; filePattern: string },
      ][];
      expect(
        queries.map(([query]) => [query.filePattern, query.folderQueries.map(folder => folder.folder.toString())]),
      ).toEqual([
        ['b', ['file:///two']],
        ['b', ['file:///one', 'file:///two']],
      ]);
    });

    it('offers open untitled documents when the workspace has no file folders', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'remote', uri: URI.parse('vscode-remote://host/workspace') });
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      expect(await createController(services).searchFiles('')).toMatchObject([{ path: 'Untitled-1' }]);
      expect(services.search.fileSearch).not.toHaveBeenCalled();
    });

    it('tolerates a root folder without listed children', async () => {
      const services = controllerServices();
      services.stats.set('/workspace', {});
      expect(await createController(services).searchFiles('')).toMatchObject([{ path: './', name: 'workspace' }]);
    });

    it('stops climbing folders at the root of the file system', async () => {
      const services = controllerServices();
      const root = { name: 'server', uri: URI.from({ scheme: 'file', authority: 'server', path: '/' }) };
      services.folders.splice(0, 1);
      services.workspace.getWorkspaceFolder.mockReturnValue(root);
      services.adapter.contextPath.mockImplementation((uri: URI) => uri.path);
      services.models.push({ uri: URI.file('/a/b.ts') });
      expect((await createController(services).searchFiles('')).map(candidate => candidate.uri)).toEqual([
        'file:///a/b.ts',
        'file:///a',
        'file:///',
      ]);
    });
  });

  describe(GlyphContextController.prototype.selectFiles, () => {
    it('captures every file chosen in the open dialog', async () => {
      const services = controllerServices();
      services.dialogs.showOpenDialog.mockResolvedValue([URI.file('/workspace/a.ts'), URI.file('/workspace/b.ts')]);
      const controller = createController(services);
      expect((await controller.selectFiles()).map(attachment => attachment.path)).toEqual(['a.ts', 'b.ts']);
      expect(services.dialogs.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultUri: URI.file('/workspace'), canSelectMany: true }),
      );
    });

    it('captures nothing when the open dialog is dismissed', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1);
      expect(await createController(services).selectFiles()).toEqual([]);
      expect(services.dialogs.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: undefined }));
    });
  });

  describe(GlyphContextController.prototype.captureFile, () => {
    it('refuses to capture in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        message: 'Trust this workspace before attaching context.',
      });
    });

    it('refuses a file that has been deleted', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
      });
    });

    it('captures an open untitled document', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      expect(await createController(services).captureFile('untitled:Untitled-1')).toMatchObject({ path: 'Untitled-1' });
      expect(services.files.exists).not.toHaveBeenCalled();
    });

    it('refuses a closed untitled document', async () => {
      const services = controllerServices();
      await expect(createController(services).captureFile('untitled:Untitled-1')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      });
    });

    it('refuses an unopened file larger than the attachment limit', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/a.ts', { size: 512 * 1024 + 1 });
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
      expect(services.resolver.createModelReference).not.toHaveBeenCalled();
    });

    it('captures an unopened file of unknown size and releases its model', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/a.ts', {});
      expect(await createController(services).captureFile('file:///workspace/a.ts')).toMatchObject({ path: 'a.ts' });
      const reference = (await services.resolver.createModelReference.mock.results[0].value) as { dispose: Mock };
      expect(reference.dispose).toHaveBeenCalledOnce();
    });
  });

  describe(GlyphContextController.prototype.captureResources, () => {
    it.each([[[]], [Array.from({ length: 33 }, (_, index) => `file:///workspace/${index}.ts`)]])(
      'refuses to capture %j resources',
      async resources => {
        await expect(createController(controllerServices()).captureResources(resources)).rejects.toThrow(
          'Select between 1 and 32 files or folders to attach.',
        );
      },
    );

    it('captures each distinct file and folder once', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      expect(
        (
          await createController(services).captureResources([
            'file:///workspace/a.ts',
            'file:///workspace/src',
            'file:///workspace/a.ts',
          ])
        ).map(attachment => [attachment.kind, attachment.path]),
      ).toEqual([
        [GlyphContextAttachmentKind.FILE, 'a.ts'],
        [GlyphContextAttachmentKind.FOLDER, 'src'],
      ]);
    });
  });

  describe(GlyphContextController.prototype.captureFolder, () => {
    it('captures the search-visible outline of a nested folder', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src/deep', { isDirectory: true });
      services.search.fileSearch.mockResolvedValue({
        results: [
          { resource: URI.file('/workspace/src/deep/a.ts') },
          { resource: URI.file('/workspace/src/deep/inner/b.ts') },
          { resource: URI.file('/workspace/src/deeper.ts') },
        ],
        limitHit: true,
      });
      const attachment = await createController(services).captureFolder('file:///workspace/src/deep');
      expect(attachment).toMatchObject({
        kind: GlyphContextAttachmentKind.FOLDER,
        uri: 'file:///workspace/src/deep',
        path: 'src/deep',
        text: `Directory tree: src/deep\n(Search-visible paths; file contents are not included.)\n\n${formatFolderContextOutline(['a.ts', 'inner/b.ts'], true)}`,
      });
      expect(services.files.stat.mock.calls.map(([uri]) => uri.path)).toEqual([
        '/workspace/src/deep',
        '/workspace/src',
        '/workspace',
      ]);
    });

    it('uses the root scope when capturing or rebinding a named workspace folder', async () => {
      const services = controllerServices();
      services.stats.set('/workspace', { isDirectory: true });
      const controller = createController(services);
      const capture = await controller.captureFolder('file:///workspace');
      expect(capture.path).toBe('.');
      expect(controller.rebindAttachment(capture).path).toBe('.');
    });

    it('names an unnamed workspace root as the current folder', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: '', uri: URI.file('/workspace') });
      services.stats.set('/workspace', { isDirectory: true });
      expect(await createController(services).captureFolder('file:///workspace')).toMatchObject({ path: '.' });
    });

    it('refuses folders that are not on disk', async () => {
      await expect(createController(controllerServices()).captureFolder('untitled:folder')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Only workspace folders can be attached.',
      });
    });

    it('refuses disk folders outside the workspace', async () => {
      const services = controllerServices();
      services.workspace.getWorkspaceFolder.mockReturnValue(undefined);

      await expect(createController(services).captureFolder('file:///elsewhere')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Only workspace folders can be attached.',
      });
    });

    it.each([
      ['a file', { isDirectory: false }],
      ['a symbolic link', { isDirectory: true, isSymbolicLink: true }],
    ])('refuses %s', async (_case, stat) => {
      const services = controllerServices();
      services.stats.set('/workspace/src', stat);
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Choose a workspace folder, not a symbolic link.',
      });
    });

    it('refuses a folder reached through a symbolic link', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/link/src', { isDirectory: true });
      services.stats.set('/workspace/link', { isDirectory: true, isSymbolicLink: true });
      await expect(createController(services).captureFolder('file:///workspace/link/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Folder context cannot traverse symbolic links.',
      });
    });

    it('stops checking ancestors at the root of the file system', async () => {
      const services = controllerServices();
      const root = { name: 'server', uri: URI.from({ scheme: 'file', authority: 'server', path: '/' }) };
      services.workspace.getWorkspaceFolder.mockReturnValue(root);
      services.adapter.contextPath.mockImplementation((uri: URI) => uri.path);
      services.stats.set('/a/b', { isDirectory: true });
      services.stats.set('/a', { isDirectory: true });
      services.stats.set('/', { isDirectory: true });
      expect(await createController(services).captureFolder('file:///a/b')).toMatchObject({ path: '/a/b' });
      expect(services.files.stat.mock.calls.map(([uri]) => uri.toString())).toEqual([
        'file:///a/b',
        'file:///a',
        'file:///',
      ]);
    });

    it('refuses an outline larger than the attachment limit', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockResolvedValue({
        results: Array.from({ length: 1000 }, (_, index) => ({
          resource: URI.file(`/workspace/src/${String(index).padStart(600, '0')}.ts`),
        })),
      });
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
    });

    it('refuses a capture whose workspace path changed meanwhile', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockImplementation(async () => {
        services.folders.splice(0, 1, { name: 'other', uri: URI.file('/workspace/src') });
        return { results: [] };
      });
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });

    it('refuses a capture whose workspace folder disappeared meanwhile', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockImplementation(async () => {
        services.folders.splice(0);
        return { results: [] };
      });

      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });
  });

  describe(GlyphContextController.prototype.refreshAttachment, () => {
    it('refuses to refresh an immutable IDE capture', async () => {
      await expect(
        createController(controllerServices()).refreshAttachment({
          kind: GlyphContextAttachmentKind.DIAGNOSTIC,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
        }),
      ).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
    });

    it('refreshes a folder outline and keeps its identity', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      const controller = createController(services);
      const folder = {
        kind: GlyphContextAttachmentKind.FOLDER,
        uri: 'file:///workspace/src',
        path: 'src',
        text: '',
        contentRevision: '',
      };
      expect(await controller.refreshAttachment({ ...folder, id: 'kept' })).toMatchObject({ id: 'kept', path: 'src' });
      expect((await controller.refreshAttachment(folder)).id).not.toBe('kept');
    });

    it('recaptures a selection and keeps its identity and side', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } };
      expect(
        await createController(services).refreshAttachment({
          id: 'kept',
          kind: GlyphContextAttachmentKind.SELECTION,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
          range,
          side: 'original',
        }),
      ).toEqual({
        id: 'kept',
        kind: GlyphContextAttachmentKind.SELECTION,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
        range,
        side: 'original',
      });
    });

    it('recaptures a file as a fresh attachment', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      expect(
        await createController(services).refreshAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
        }),
      ).toEqual({
        id: 'capture',
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });
  });

  describe(GlyphContextController.prototype.checkAttachment, () => {
    const token = {
      workspaceGeneration: 'generation',
      resource: 'file:///workspace/a.ts',
      incarnation: 'one',
      version: 1,
    };

    it('reports an attachment already marked unavailable', async () => {
      expect(
        await createController(controllerServices()).checkAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: '',
          contentRevision: '',
          unavailable: 'Gone.',
        }),
      ).toBe('Gone.');
    });

    it('describes IDE captures and flags those whose source changed', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      const controller = createController(services);
      const capture = {
        kind: GlyphContextAttachmentKind.DIAGNOSTIC,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: '',
        contentRevision: '',
      };
      const preserved =
        'Captured IDE context. Capture again from the originating surface to refresh; the original snapshot is preserved.';
      expect(await controller.checkAttachment({ ...capture, token })).toBe(preserved);
      services.adapter.isCurrentContext.mockReturnValue(false);
      expect(await controller.checkAttachment({ ...capture, token })).toBe(
        `Source changed; this capture is stale. ${preserved}`,
      );
      expect(await controller.checkAttachment(capture)).toBe(preserved);
      expect(await controller.checkAttachment({ ...capture, uri: 'file:///workspace/b.ts', token })).toBe(preserved);
    });

    it('reports a deleted source', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      expect(
        await createController(services).checkAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: '',
          contentRevision: '',
        }),
      ).toBe('Source deleted. The captured text is preserved.');
    });

    it('describes a folder outline', async () => {
      expect(
        await createController(controllerServices()).checkAttachment({
          kind: GlyphContextAttachmentKind.FOLDER,
          uri: 'file:///workspace/src',
          path: 'src',
          text: '',
          contentRevision: '',
        }),
      ).toBe('Captured folder outline. Refresh explicitly to update it.');
    });

    it('reports whether an open source still matches its capture', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      const controller = createController(services);
      const attachment = {
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'untitled:Untitled-1',
        path: 'Untitled-1',
        text: '',
        contentRevision: '',
        token,
      };
      expect(await controller.checkAttachment(attachment)).toBeUndefined();
      services.adapter.isCurrentContext.mockReturnValue(false);
      expect(await controller.checkAttachment(attachment)).toBe(
        'Source changed. Refresh explicitly to replace the captured text.',
      );
      expect(await controller.checkAttachment({ ...attachment, uri: 'untitled:Untitled-2' })).toBe(
        'Source closed. The captured text is preserved.',
      );
      expect(services.files.exists).not.toHaveBeenCalled();
    });
  });

  describe(GlyphContextController.prototype.rebindAttachment, () => {
    const attachment = {
      kind: GlyphContextAttachmentKind.FILE,
      path: 'old/a.ts',
      text: 'text',
      contentRevision: 'revision',
      token: { workspaceGeneration: 'generation', resource: 'file:///workspace/a.ts', incarnation: 'one', version: 1 },
      unavailable: 'Earlier problem.',
    };

    it('keeps untitled captures without their token', () => {
      expect(
        createController(controllerServices()).rebindAttachment({ ...attachment, uri: 'untitled:Untitled-1' }),
      ).toEqual({
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'untitled:Untitled-1',
        path: 'old/a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });

    it('marks captures of other resources unavailable', () => {
      expect(
        createController(controllerServices()).rebindAttachment({
          ...attachment,
          uri: 'vscode-test-data://results/run',
        }),
      ).toMatchObject({ unavailable: 'Workspace changed. Capture this context again before sending.' });
    });

    it('marks captures outside of the workspace unavailable', () => {
      expect(
        createController(controllerServices()).rebindAttachment({ ...attachment, uri: 'file:///elsewhere/a.ts' }),
      ).toMatchObject({
        unavailable: 'Source folder was removed. Remove this attachment or add its folder again before sending.',
      });
    });

    it('renames workspace captures to their current path', () => {
      const rebound = createController(controllerServices()).rebindAttachment({
        ...attachment,
        uri: 'file:///workspace/a.ts',
      });
      expect(rebound).toEqual({
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });
  });

  it('rechecks manual eligibility for restored badges and refreshes their catalog revision', async () => {
    const services = controllerServices();
    const controller = createController(services);
    const attachment: GlyphContextAttachment = {
      kind: GlyphContextAttachmentKind.RULE,
      ruleId: 'r',
      uri: 'glyph-rule:r',
      text: '',
      path: 'rule',
      contentRevision: 'old',
    };
    const rule = {
      id: 'r',
      path: 'rules/r.mdc',
      status: 'active',
      activation: 'manual',
      name: 'New name',
      revision: 'new',
    };
    const refresh = vi.fn(async () => {});
    controller.setInstructionRefresh(refresh);
    expect(await controller.checkAttachment(attachment)).toContain('unavailable');
    await expect(controller.refreshAttachment(attachment)).rejects.toThrow('unavailable');
    services.instructionSources.push(rule);
    const { ruleId: _ruleId, ...legacy } = attachment;
    expect(await controller.checkAttachment(legacy)).toContain('instructions changed');
    expect((await controller.refreshAttachment(legacy)).contentRevision).toBe('new');
    expect(controller.rebindAttachment({ ...attachment, unavailable: 'previous root' })).toEqual(attachment);
    expect(await controller.checkAttachment(attachment)).toContain('instructions changed');
    const current = await controller.refreshAttachment({ ...attachment, unavailable: 'previously disabled' });
    expect(current).toMatchObject({ path: 'New name', contentRevision: 'new' });
    expect(current.unavailable).toBeUndefined();
    expect(await controller.checkAttachment(current)).toBeUndefined();
    services.instructionSources[0] = { ...rule, name: undefined, revision: undefined };
    expect(await controller.refreshAttachment(attachment)).toMatchObject({ path: 'rule', contentRevision: 'r' });
    expect(await controller.checkAttachment(attachment)).toBeUndefined();
    rule.activation = 'always';
    services.instructionSources[0] = rule;
    expect(await controller.checkAttachment(attachment)).toContain('unavailable');
    await expect(controller.refreshAttachment(attachment)).rejects.toThrow('unavailable');
  });

  it('opens a registered alias through the logical editor URI only while its physical file still matches', async () => {
    const services = controllerServices();
    const controller = createController(services);
    const physical = URI.file('/actual/AGENTS.md');
    const source = { id: 'guidance', path: 'AGENTS.md', status: 'active', uri: physical.toString() };
    services.instructionSources.push(source);
    services.files.stat.mockImplementation(async uri => ({
      isFile: uri.path.endsWith('.md'),
      isDirectory: !uri.path.endsWith('.md'),
      isSymbolicLink: uri.path === '/workspace',
    }));
    services.files.realpath.mockResolvedValue(physical);
    const history = vi.fn(async (id: string) => (id === 'old' ? 'guidance' : undefined));
    controller.setInstructionRefresh(undefined, undefined, history);
    await controller.openInstruction('old');
    await expect(controller.openInstruction('gone')).rejects.toThrow('unavailable');
    await controller.openInstruction('guidance');
    expect(history.mock.calls).toEqual([['old'], ['gone']]);
    expect(services.editors.openEditor).toHaveBeenCalledWith({
      resource: expect.objectContaining({ path: '/workspace/AGENTS.md' }),
      options: { pinned: true },
    });
    services.files.realpath.mockResolvedValue(URI.file('/actual/agents.md'));
    services.instructionSources[0] = { ...source, caseSensitive: false };
    await controller.openInstruction('guidance');
    services.instructionSources[0] = { ...source, caseSensitive: true };
    await expect(controller.openInstruction('guidance')).rejects.toThrow('unavailable');
    services.files.realpath.mockResolvedValue(undefined);
    await expect(controller.openInstruction('guidance')).rejects.toThrow('unavailable');
    services.files.stat.mockResolvedValueOnce({ isFile: true, isSymbolicLink: true });
    await expect(controller.openInstruction('guidance')).rejects.toThrow('unavailable');
  });
  it('opens only currently authorized instruction files through their owning root', async () => {
    const services = controllerServices();
    const controller = createController(services);
    const project = { id: 'r', path: '.glyph/rules/r.mdc', status: 'error', revision: 'source' };
    const user = {
      id: 'u',
      path: '~/.glyph/rules/u.mdc',
      status: 'active',
      kind: 'glyph_user_rule',
      uri: 'file:///profile/.glyph/rules/u.mdc',
    };
    services.instructionSources.push(project, user);
    controller.setInstructionRefresh(
      vi.fn(async () => {}),
      () => ['file:///profile/.glyph/rules'],
    );
    services.files.stat.mockImplementation(async uri =>
      uri.path.endsWith('.mdc') ? { isFile: true } : { isDirectory: true },
    );
    await controller.openAttachment({ path: 'r', uri: 'glyph-rule:r' });
    await controller.openInstruction('u');
    expect(services.editors.openEditor).toHaveBeenCalledWith({
      resource: expect.objectContaining({ path: '/workspace/.glyph/rules/r.mdc' }),
      options: { pinned: true },
    });
    expect(services.editors.openEditor).toHaveBeenCalledWith({
      resource: expect.objectContaining({ path: '/profile/.glyph/rules/u.mdc' }),
      options: { pinned: true },
    });

    services.folders.push({ name: 'other', uri: URI.file('/other') });
    project.path = 'other/r.mdc';
    await controller.openInstruction('r');
    expect(services.editors.openEditor).toHaveBeenCalledWith({
      resource: expect.objectContaining({ path: '/other/r.mdc' }),
      options: { pinned: true },
    });
    for (const path of [
      'missing/r.mdc',
      'other',
      'other/../r.mdc',
      'other/./r.mdc',
      'other//r.mdc',
      'other/a\\r.mdc',
    ]) {
      project.path = path;
      await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    }
    for (const uri of ['', 'file:///other/u.mdc', 'untitled:/profile/.glyph/rules/u.mdc']) {
      user.uri = uri;
      await expect(controller.openInstruction('u')).rejects.toThrow('unavailable');
    }
    project.path = 'other/r.mdc';
    for (const denied of [{ isSymbolicLink: true }, { isDirectory: true }]) {
      services.files.stat.mockResolvedValueOnce(denied);
      await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    }
    services.files.stat
      .mockResolvedValueOnce({ isFile: true })
      .mockResolvedValueOnce({ isDirectory: true, isSymbolicLink: true });
    await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    services.files.stat.mockResolvedValueOnce({ isFile: true }).mockResolvedValueOnce({ isFile: true });
    await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    services.files.stat.mockImplementationOnce(async () => {
      services.instructionSources.shift();
      return { isFile: true };
    });
    await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    await expect(controller.openInstruction('missing')).rejects.toThrow('unavailable');
    services.instructionSources.push({ ...project, revision: undefined });
    await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    services.instructionSources[1].managementRevision = 'source';
    await controller.openInstruction('r');
    services.files.stat.mockImplementationOnce(async () => {
      services.folders.pop();
      return { isFile: true };
    });
    await expect(controller.openInstruction('r')).rejects.toThrow('unavailable');
    services.trust.isWorkspaceTrusted.mockReturnValue(false);
    await expect(controller.openInstruction('r')).rejects.toThrow('Trust this workspace');
  });

  describe(GlyphContextController.prototype.openAttachment, () => {
    it('leaves sources that the IDE context opens to it', async () => {
      const services = controllerServices();
      services.ide.openSource.mockResolvedValue(true);
      await createController(services).openAttachment({ path: 'Terminal 1', uri: 'glyph-terminal:/id/1' });
      expect(services.editors.openEditor).not.toHaveBeenCalled();
    });

    it('opens a workspace path at its captured range', async () => {
      const services = controllerServices();
      const controller = createController(services);
      await controller.openAttachment({
        path: 'src/a.ts',
        range: { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } },
      });
      await controller.openAttachment({ path: 'src/a.ts' });
      expect(services.editors.openEditor.mock.calls).toEqual([
        [
          {
            resource: URI.file('/workspace/src/a.ts'),
            options: {
              pinned: true,
              selection: { startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 4 },
            },
          },
        ],
        [{ resource: URI.file('/workspace/src/a.ts'), options: { pinned: true } }],
      ]);
      expect(services.ide.openSource).not.toHaveBeenCalled();
    });

    it('opens a path under its root in a multi-root workspace', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
      await createController(services).openAttachment({ path: 'two/src/a.ts' });
      expect(services.editors.openEditor).toHaveBeenCalledWith({
        resource: URI.file('/two/src/a.ts'),
        options: { pinned: true },
      });
    });

    it.each(['three/a.ts', 'one/../a.ts', 'one//etc/passwd', 'one/c:/a.ts'])(
      'refuses the unavailable multi-root path %s',
      async path => {
        const services = controllerServices();
        services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
        await expect(createController(services).openAttachment({ path })).rejects.toMatchObject({
          code: GlyphDesktopErrorCode.NOT_FOUND,
          message: 'The attachment source is unavailable in this workspace.',
        });
      },
    );

    it('refuses a path when the workspace has no file folders', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1);
      await expect(createController(services).openAttachment({ path: 'a.ts' })).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
      });
    });

    it('refuses a deleted source', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      await expect(
        createController(services).openAttachment({ path: 'a.ts', uri: 'file:///workspace/a.ts' }),
      ).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
        message: 'Source deleted. The captured text is preserved.',
      });
    });

    it('opens an untitled source only while it is open', async () => {
      const services = controllerServices();
      const controller = createController(services);
      await expect(controller.openAttachment({ path: 'Untitled-1', uri: 'untitled:Untitled-1' })).rejects.toMatchObject(
        {
          code: GlyphDesktopErrorCode.NOT_FOUND,
          message: 'The untitled source is closed. The captured text is preserved.',
        },
      );
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      await controller.openAttachment({ path: 'Untitled-1', uri: 'untitled:Untitled-1' });
      expect(services.editors.openEditor).toHaveBeenCalledWith({
        resource: expect.objectContaining({ scheme: 'untitled', path: 'Untitled-1' }),
        options: { pinned: true },
      });
    });

    it('reveals a folder in the explorer', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      await createController(services).openAttachment({ path: 'src', uri: 'file:///workspace/src' });
      expect(services.commands.executeCommand).toHaveBeenCalledWith('revealInExplorer', URI.file('/workspace/src'));
      expect(services.editors.openEditor).not.toHaveBeenCalled();
    });
  });
});
