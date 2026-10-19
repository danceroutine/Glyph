import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GlyphService } from '#src/application/GlyphService.js';
import { OpenAIDesktopRuntimeFactory } from '#src/desktop/host/OpenAIDesktopRuntimeFactory.js';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { contentRevision } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { EnvironmentConfigurationProvider } from '#src/configuration/EnvironmentConfigurationProvider.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { SqliteChatSessionStore } from '#src/chat/sessions/SqliteChatSessionStore.js';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { OpenAIBackend } from '#src/providers/openai/OpenAIBackend.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';

describe(OpenAIDesktopRuntimeFactory, () => {
  it('loads saved chats and reviews without project access while untrusted and reconciles after trust returns', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-untrusted-history-')));
    const root = join(directory, 'workspace');
    const state = join(directory, 'state');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', state);
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.spyOn(OpenAIBackend.prototype, 'initialize').mockResolvedValue();
    const indexing = vi.spyOn(RustWorkspacePathIndex.prototype, 'initialize').mockResolvedValue({
      root,
      fileCount: 1,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    });
    const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
    const roots = [{ name: 'workspace', path: root }];
    const context = {
      id: ProjectContextIdentity.create(ProjectContextKind.WORKSPACE, 'file', 'profile:workspace'),
      mutationIdentity: ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, 'file', roots),
      kind: ProjectContextKind.FOLDER,
      name: 'workspace',
      authority: 'file',
      roots,
    };
    const disk = new FileSystemWorkspaceTextStore(root);
    const base = await disk.read('file.txt');
    const proposal = await new EditProposalService(
      disk,
      new JsDiffTextDiffer(),
      new EnvironmentConfigurationProvider().editing,
    ).proposeStructured({
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: base.revision,
          content: 'proposed',
          byte_order_mark: false,
          edits: [],
        },
      ],
    });
    const reviewStore = new FileProposalReviewStore(
      join(state, 'projects', ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'file', 'profile:workspace')),
      { mutationScope: context.mutationIdentity },
    );
    await reviewStore.save([proposal], context.mutationIdentity);
    const chats = new SqliteChatSessionStore(state);
    await chats.initialize(context);
    await chats.save({
      schemaVersion: 3,
      id: 'saved-chat',
      title: 'Saved chat',
      titleOrigin: 'human',
      projectContextId: context.id,
      accountProvider: 'openai',
      accountId: 'fixture',
      modelSlug: 'model',
      modelName: 'Model',
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
      providerState: { provider: 'fixture', version: 1, data: null },
      transcript: [],
    });
    await chats.dispose();
    let trusted = true;
    const editor = new EditorRpcRouter();
    const requests = vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      const operationId =
        request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
        request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
          ? request.mutation.operationId
          : request.operationId;
      if (!trusted)
        return {
          operationId,
          ok: false,
          error: {
            code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
            message: 'Workspace is untrusted',
            retryable: false,
          },
        };
      return {
        operationId,
        ok: true,
        snapshot: {
          uri: `file://${root}/file.txt`,
          path: 'file.txt',
          text: 'original',
          byteOrderMark: false,
          contentRevision: base.revision,
          byteLength: 8,
          mode: 0o644,
          identity: base.identity,
          dirty: false,
          token: {
            workspaceGeneration: 'workspace',
            resource: `file://${root}/file.txt`,
            incarnation: 'model',
            version: 1,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      for (trusted of [true, false, true]) {
        requests.mockClear();
        indexing.mockClear();
        const input = {
          identity,
          roots: [{ name: 'workspace', canonicalPath: root, uri: `file://${root}` }],
          trusted,
          emit: () => {},
        };
        runtime = await factory.create(input);
        expect((await runtime.snapshot()).chats.map(chat => chat.id)).toEqual(['saved-chat']);
        expect((await runtime.snapshot()).proposals.map(value => value.id)).toEqual([proposal.id]);
        expect(requests).toHaveBeenCalledTimes(trusted ? 1 : 0);
        expect(indexing).toHaveBeenCalledTimes(trusted ? 1 : 0);
        await runtime.dispose();
        runtime = undefined;
      }
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['My Project', 'café'])('reopens the pre-routing checkpoint for an unchanged %s root', async name => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-compatible-root-')));
    const root = join(directory, 'workspace');
    const state = join(directory, 'state');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', state);
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    let recoveredIds: readonly string[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      await this.proposalReviews?.initialize();
      recoveredIds = this.proposalReviews!.activeReviews.map(review => review.id);
    });
    const workspace = new FileSystemWorkspaceTextStore(root);
    const service = new EditProposalService(
      workspace,
      new JsDiffTextDiffer(),
      new EnvironmentConfigurationProvider().editing,
      new NullLogger(),
    );
    const base = await workspace.read('file.txt');
    const proposal = await service.proposeStructured({
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: base.revision,
          content: null,
          byte_order_mark: null,
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
              expected_text: 'original',
              replacement_text: 'changed',
            },
          ],
        },
      ],
    });
    const identity = ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'file', 'profile:workspace');
    const scope = ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, 'file', [{ name, path: root }]);
    await new FileProposalReviewStore(join(state, 'projects', identity), { mutationScope: scope }).save(
      [proposal],
      scope,
    );
    const editors = new EditorRpcRouter();
    vi.spyOn(editors, 'request').mockResolvedValue({
      operationId: 'fixture',
      ok: true,
      snapshot: {
        ...base,
        contentRevision: base.revision,
        uri: `file://${root}/file.txt`,
        dirty: false,
        token: {
          workspaceGeneration: 'workspace',
          resource: `file://${root}/file.txt`,
          incarnation: 'model',
          version: 1,
        },
      },
    });
    const factory = new OpenAIDesktopRuntimeFactory(editors);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots: [{ name, canonicalPath: root, uri: `file://${root}` }],
        trusted: true,
        emit: () => {},
      });
      expect(recoveredIds).toEqual([proposal.id]);
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('initializes distinct roots with duplicate display names instead of rejecting the workspace', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-routing-')));
    const roots = ['one', 'two'].map(value => ({
      name: 'app',
      canonicalPath: join(directory, value),
      uri: `file://${directory}/${value}`,
    }));
    for (const root of roots) await mkdir(root.canonicalPath);
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.spyOn(GlyphService.prototype, 'initialize').mockResolvedValue();
    const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter());
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots,
        trusted: true,
        emit: () => {},
      });
      expect(runtime).toBeDefined();
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([ProjectContextKind.WORKSPACE, ProjectContextKind.FOLDER])(
    'preserves existing %s chats through two-to-one folder changes without exposing another workspace or profile',
    async legacyKind => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-chat-identity-')));
      const state = join(directory, 'state');
      const roots = ['A', 'B'].map(name => ({ name, path: join(directory, 'workspace', name) }));
      for (const root of roots) await mkdir(root.path, { recursive: true });
      vi.stubEnv('GLYPH_CONFIG_DIR', state);
      vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
      vi.spyOn(OpenAIBackend.prototype, 'initialize').mockResolvedValue();
      vi.spyOn(RustWorkspacePathIndex.prototype, 'initialize').mockResolvedValue({
        root: directory,
        fileCount: 0,
        fromCache: false,
        truncated: false,
        durationMilliseconds: 0,
      });
      const store = new SqliteChatSessionStore(state);
      const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter());
      let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
      try {
        for (const identity of [
          'profile:saved-workspace',
          'profile:other-workspace',
          'other-profile:saved-workspace',
        ]) {
          const context = {
            id: ProjectContextIdentity.create(legacyKind, 'file', identity),
            kind: legacyKind,
            mutationIdentity: ProjectContextIdentity.createMutationScope(legacyKind, 'file', roots),
            name: 'Saved workspace',
            authority: 'file',
            roots,
          };
          await store.initialize(context);
          await store.save({
            schemaVersion: 3,
            id: identity,
            title: 'Keep my conversation',
            titleOrigin: 'human',
            projectContextId: context.id,
            accountProvider: 'openai',
            accountId: 'fixture',
            modelSlug: 'model',
            modelName: 'Model',
            createdAt: '2026-10-12T00:00:00Z',
            updatedAt: '2026-10-12T00:00:00Z',
            providerState: { provider: 'fixture', version: 1, data: { history: ['preserve'] } },
            transcript: [
              {
                userText: 'Original question',
                assistantText: 'Original answer',
                reasoningSummary: '',
                attachmentPaths: [],
                createdAt: '2026-10-12T00:00:00Z',
              },
            ],
          });
        }
        await store.dispose();
        for (const count of [2, 1, 2]) {
          runtime = await factory.create({
            trusted: true,
            identity: { profileId: 'profile', workspaceId: 'saved-workspace', windowId: 'window' },
            roots: roots
              .slice(0, count)
              .map(root => ({ name: root.name, canonicalPath: root.path, uri: `file://${root.path}` })),
            emit: () => {},
          });
          expect((await runtime.snapshot()).chats.map(chat => chat.id)).toEqual(['profile:saved-workspace']);
          await runtime.dispose();
          runtime = undefined;
        }
      } finally {
        await runtime?.dispose();
        await store.dispose();
        await factory.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('reopens a saved workspace after adding a folder while preserving the original scope pending reviews', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-review-scopes-')));
    const project = join(directory, 'workspace');
    for (const name of ['A', 'B', 'C']) await mkdir(join(project, name), { recursive: true });
    await writeFile(join(project, 'A/file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    const services: GlyphService[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      await this.proposalReviews?.initialize();
      services.push(this);
    });
    const editor = new EditorRpcRouter();
    vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => ({
      operationId:
        request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
        request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
          ? request.mutation.operationId
          : request.operationId,
      ok: true,
      snapshot: {
        uri: `file://${project}/A/file.txt`,
        path: 'A/file.txt',
        text: 'original',
        contentRevision: contentRevision('original', false),
        byteLength: 8,
        byteOrderMark: false,
        mode: 0o644,
        identity: 'fixture',
        dirty: false,
        token: {
          workspaceGeneration: 'workspace',
          resource: `file://${project}/A/file.txt`,
          incarnation: 'model',
          version: 1,
        },
      },
    }));
    const factory = new OpenAIDesktopRuntimeFactory(editor);
    const runtimes: Awaited<ReturnType<typeof factory.create>>[] = [];
    const open = async (names: string[]) => {
      const runtime = await factory.create({
        trusted: true,
        identity: { profileId: 'profile', workspaceId: 'saved-workspace', windowId: 'window' },
        roots: names.map(name => ({ name, canonicalPath: join(project, name), uri: `file://${project}/${name}` })),
        emit: () => {},
      });
      runtimes.push(runtime);
      return runtime;
    };
    try {
      const workspace = new FileSystemWorkspaceTextStore(project);
      const service = new EditProposalService(
        workspace,
        new JsDiffTextDiffer(),
        new EnvironmentConfigurationProvider().editing,
        new NullLogger(),
      );
      const base = await workspace.read('A/file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'A/file.txt',
            new_path: null,
            base_revision: base.revision,
            content: null,
            byte_order_mark: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                expected_text: 'original',
                replacement_text: 'changed',
              },
            ],
          },
        ],
      });
      await open(['A', 'B']);
      await services[0]!.proposalReviews!.stage(proposal);
      await runtimes.pop()!.dispose();
      await open(['A', 'B', 'C']);
      expect(services[1]!.proposalReviews!.activeReviews).toEqual([]);
      await runtimes.pop()!.dispose();
      await open(['A', 'B']);
      expect(services[2]!.proposalReviews!.activeReviews.map(review => review.id)).toEqual([proposal.id]);
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies read budgets to a smaller unsaved editor buffer instead of its oversized disk version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-live-read-budget-'));
    const root = join(directory, 'workspace');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'old disk content'.repeat(100));
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.stubEnv('CONTEXT_MAX_FILE_BYTES', '32');
    const services: GlyphService[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      services.push(this);
    });
    const editor = new EditorRpcRouter();
    const request = vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      expect(request.type).toBe(GlyphEditorRequestType.READ_SNAPSHOT);
      return {
        operationId:
          request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
          request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
            ? request.mutation.operationId
            : request.operationId,
        ok: true,
        snapshot: {
          uri: 'file:///fixture/file.txt',
          path: 'file.txt',
          text: 'tiny',
          contentRevision: contentRevision('tiny', false),
          byteLength: 4,
          byteOrderMark: false,
          mode: 0o644,
          identity: 'fixture',
          dirty: true,
          token: {
            workspaceGeneration: 'workspace',
            resource: 'file:///fixture/file.txt',
            incarnation: 'model',
            version: 1,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots: [{ name: 'workspace', canonicalPath: root, uri: `file://${root}` }],
        trusted: true,
        emit: () => {},
      });
      const service = services[0]!;
      await expect(service.resolveChatRequest('Read my buffer', [{ path: 'file.txt' }])).resolves.toMatchObject({
        attachments: [{ text: 'tiny', byteLength: 4 }],
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]).toMatchObject({ maxBytes: 32 });
      // Metadata-only validation must not turn editor RPC into a policy bypass.
      await writeFile(join(root, '.env'), 'harmless excluded fixture');
      await symlink(join(root, 'file.txt'), join(root, 'alias.txt'));
      await expect(service.resolveChatRequest('Excluded', [{ path: '.env' }])).rejects.toThrow();
      await expect(service.resolveChatRequest('Symlink', [{ path: 'alias.txt' }])).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
