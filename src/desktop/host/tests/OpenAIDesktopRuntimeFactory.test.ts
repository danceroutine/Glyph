import { GlyphMutationReceiptState } from '#src/desktop/protocol/editor/GlyphMutationReceipt.js';
import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionSummary } from '#src/chat/sessions/ChatSessionRecord.js';
import type { RustWorkspacePathIndexConfiguration } from '#src/context/search/RustWorkspacePathIndexOptions.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { GlyphFileMutationKind, type GlyphFileMutation } from '#src/desktop/protocol/editor/GlyphFileMutation.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { EditorWorkspaceClient } from '#src/desktop/workspace/EditorWorkspaceClient.js';
import type { ModeSwitchToolRuntime } from '#src/interaction/modes/ModeSwitchToolRuntime.js';
import type { PlanToolRuntime } from '#src/planning/PlanToolRuntime.js';
import { OpenAIAccountService } from '#src/providers/openai/auth/OpenAIAccountService.js';
import type { OpenAIProviderFactory } from '#src/providers/openai/OpenAIProviderFactory.js';
import type { ConversationAgentReviewExecutor } from '#src/reviewing/ConversationAgentReviewExecutor.js';
import { AgentReviewService } from '#src/reviewing/AgentReviewService.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';
import type { TodoToolRuntime } from '#src/todos/TodoToolRuntime.js';

const captured = vi.hoisted(() => ({
  editorClients: [] as EditorWorkspaceClient[],
  indexOptions: [] as RustWorkspacePathIndexConfiguration[],
  modeSwitches: [] as ConstructorParameters<typeof ModeSwitchToolRuntime>[0][],
  plans: [] as ConstructorParameters<typeof PlanToolRuntime>[0][],
  todos: [] as ConstructorParameters<typeof TodoToolRuntime>[0][],
  reviewExecutors: [] as ConstructorParameters<typeof ConversationAgentReviewExecutor>[0][],
  conversations: [] as ConstructorParameters<typeof ChatConversation>[],
  brokers: [] as { readonly broker: DesktopInteractionBroker; readonly emit: (event: GlyphHostEvent) => void }[],
  providerFactories: [] as ConstructorParameters<typeof OpenAIProviderFactory>[],
}));

vi.mock('#src/desktop/workspace/EditorWorkspaceTextStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/desktop/workspace/EditorWorkspaceTextStore.js')>();
  return {
    ...actual,
    EditorWorkspaceTextStore: class extends actual.EditorWorkspaceTextStore {
      constructor(...arguments_: ConstructorParameters<typeof actual.EditorWorkspaceTextStore>) {
        super(...arguments_);
        captured.editorClients.push(arguments_[2]);
      }
    },
  };
});

vi.mock('#src/context/search/RustWorkspacePathIndex.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/context/search/RustWorkspacePathIndex.js')>();
  return {
    ...actual,
    RustWorkspacePathIndex: class extends actual.RustWorkspacePathIndex {
      constructor(...arguments_: ConstructorParameters<typeof actual.RustWorkspacePathIndex>) {
        super(...arguments_);
        captured.indexOptions.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/interaction/modes/ModeSwitchToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/interaction/modes/ModeSwitchToolRuntime.js')>();
  return {
    ...actual,
    ModeSwitchToolRuntime: class extends actual.ModeSwitchToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.ModeSwitchToolRuntime>) {
        super(...arguments_);
        captured.modeSwitches.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/planning/PlanToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/planning/PlanToolRuntime.js')>();
  return {
    ...actual,
    PlanToolRuntime: class extends actual.PlanToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.PlanToolRuntime>) {
        super(...arguments_);
        captured.plans.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/todos/TodoToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/todos/TodoToolRuntime.js')>();
  return {
    ...actual,
    TodoToolRuntime: class extends actual.TodoToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.TodoToolRuntime>) {
        super(...arguments_);
        captured.todos.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/reviewing/ConversationAgentReviewExecutor.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/reviewing/ConversationAgentReviewExecutor.js')>();
  return {
    ...actual,
    ConversationAgentReviewExecutor: class extends actual.ConversationAgentReviewExecutor {
      constructor(...arguments_: ConstructorParameters<typeof actual.ConversationAgentReviewExecutor>) {
        super(...arguments_);
        captured.reviewExecutors.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/chat/ChatConversation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/chat/ChatConversation.js')>();
  return {
    ...actual,
    ChatConversation: class extends actual.ChatConversation {
      constructor(...arguments_: ConstructorParameters<typeof actual.ChatConversation>) {
        super(...arguments_);
        captured.conversations.push(arguments_);
      }
    },
  };
});

vi.mock('#src/desktop/host/DesktopInteractionBroker.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/desktop/host/DesktopInteractionBroker.js')>();
  return {
    ...actual,
    DesktopInteractionBroker: class extends actual.DesktopInteractionBroker {
      constructor(emit: (event: GlyphHostEvent) => void) {
        super(emit);
        captured.brokers.push({ broker: this, emit });
      }
    },
  };
});

vi.mock('#src/providers/openai/OpenAIProviderFactory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/providers/openai/OpenAIProviderFactory.js')>();
  return {
    ...actual,
    OpenAIProviderFactory: class extends actual.OpenAIProviderFactory {
      constructor(...arguments_: ConstructorParameters<typeof actual.OpenAIProviderFactory>) {
        super(...arguments_);
        captured.providerFactories.push(arguments_);
      }
    },
  };
});

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
    let text = 'original';
    let version = 1;
    vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      const before = contentRevision(text, false);
      const mutation = request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ? request.mutation : undefined;
      if (mutation) {
        text = mutation.text;
        version++;
      }
      return {
        operationId:
          request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
          request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
            ? request.mutation.operationId
            : request.operationId,
        ok: true,
        ...(mutation
          ? {
              receipt: {
                operationId: mutation.operationId,
                state: GlyphMutationReceiptState.APPLIED,
                beforeRevision: before,
                afterRevision: contentRevision(text, false),
                observedAt: new Date().toISOString(),
              },
            }
          : {}),
        snapshot: {
          uri: `file://${project}/A/file.txt`,
          path: 'A/file.txt',
          text,
          contentRevision: contentRevision(text, false),
          byteLength: Buffer.byteLength(text, 'utf8'),
          byteOrderMark: false,
          mode: 0o644,
          identity: 'fixture',
          dirty: false,
          token: {
            workspaceGeneration: 'workspace',
            resource: `file://${project}/A/file.txt`,
            incarnation: 'model',
            version,
          },
        },
      };
    });
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

  describe(OpenAIDesktopRuntimeFactory.prototype.create, () => {
    it('retries account initialization after a failed attempt', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      const initialize = vi
        .spyOn(OpenAIAccountService.prototype, 'initialize')
        .mockRejectedValueOnce(new Error('Credential store locked'));
      await expect(fixture.create([root])).rejects.toThrow('Credential store locked');
      await expect(fixture.create([root])).resolves.toBeInstanceOf(ProviderDesktopRuntime);
      expect(initialize).toHaveBeenCalledTimes(2);
    });

    it('requires a local workspace root', async () => {
      const fixture = await factoryFixture();
      await expect(fixture.create([])).rejects.toThrow('A local workspace root is required.');
    });

    it('uses Windows executable names on Windows', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        await fixture.create([root]);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      expect(captured.indexOptions[0]?.binaryPath).toBe(
        join(repositoryRoot, 'native', `win32-${process.arch}`, 'glyph-context-index.exe'),
      );
    });

    it('excludes packaged artifacts from a workspace root that contains them', async () => {
      const fixture = await factoryFixture();
      await fixture.create([dirname(repositoryRoot)]);
      expect(captured.indexOptions[0]?.excludedPaths).toEqual([basename(repositoryRoot)]);
    });

    it('routes single-root editor requests through filesystem policy before the editor', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace', { 'file.txt': 'disk' });
      await fixture.create([root]);
      const client = captured.editorClients[0]!;
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) => editorResponse(request, 'reported/path.txt'));
      const exists = vi.spyOn(FileSystemWorkspaceTextStore.prototype, 'exists');
      const validate = vi.spyOn(FileSystemWorkspaceTextStore.prototype, 'validateAccess');
      const signal = new AbortController().signal;
      const read = { type: GlyphEditorRequestType.READ_SNAPSHOT, operationId: 'read', path: 'file.txt' } as const;
      await expect(client.request(read, signal)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, read, signal);
      expect(validate).toHaveBeenLastCalledWith('file.txt');
      const occupancy = { type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'file.txt' } as const;
      await client.request(occupancy);
      expect(exists).toHaveBeenCalledExactlyOnceWith('file.txt');
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, occupancy, undefined);
      const text = {
        type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
        mutation: {
          operationId: 'text',
          path: 'file.txt',
          expectedContentRevision: 'revision',
          expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'text',
        },
      } as const;
      await expect(client.request(text)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, text, undefined);
      const rename = fileMutation({
        kind: GlyphFileMutationKind.RENAME,
        path: 'file.txt',
        target: 'renamed.txt',
        expectedContentRevision: 'revision',
        expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
      });
      await expect(client.request(rename)).resolves.toMatchObject({ snapshot: { path: 'renamed.txt' } });
      expect(validate).toHaveBeenLastCalledWith('renamed.txt');
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, rename, undefined);
      const create = fileMutation({
        kind: GlyphFileMutationKind.CREATE,
        path: 'new.txt',
        text: 'new',
        byteOrderMark: false,
      });
      await expect(client.request(create)).resolves.toMatchObject({ snapshot: { path: 'new.txt' } });
      const deletion = fileMutation({
        kind: GlyphFileMutationKind.DELETE,
        path: 'file.txt',
        expectedContentRevision: 'revision',
        expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
        target: undefined,
      } as unknown as FileMutationInput);
      await expect(client.request(deletion)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      for (const pathless of [
        { type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT, operationId: 'receipt' },
        { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'copies' },
      ] as const) {
        validate.mockClear();
        await expect(client.request(pathless)).resolves.toMatchObject({ snapshot: { path: 'reported/path.txt' } });
        expect(request).toHaveBeenLastCalledWith(factoryIdentity, pathless, undefined);
        expect(validate).not.toHaveBeenCalled();
      }
      request.mockResolvedValueOnce({ operationId: 'read', ok: false });
      await expect(client.request(read)).resolves.toEqual({ operationId: 'read', ok: false });
    });

    it('qualifies multi-root editor requests with the root name', async () => {
      const fixture = await factoryFixture();
      const one = await fixture.folder('one', { 'file.txt': 'one' });
      const two = await fixture.folder('two');
      await fixture.create([one, two]);
      const client = captured.editorClients[0]!;
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) => editorResponse(request, 'one/reported.txt'));
      await expect(
        client.request({ type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'file.txt' }),
      ).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(
        factoryIdentity,
        { type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'one/file.txt' },
        undefined,
      );
      const token = { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 };
      await client.request(
        fileMutation({
          kind: GlyphFileMutationKind.RENAME,
          path: 'file.txt',
          target: 'renamed.txt',
          expectedContentRevision: 'revision',
          expectedToken: token,
        }),
      );
      expect(request.mock.lastCall?.[1]).toMatchObject({
        mutation: { path: 'one/file.txt', target: 'one/renamed.txt' },
      });
      await client.request(
        fileMutation({ kind: GlyphFileMutationKind.CREATE, path: 'new.txt', text: '', byteOrderMark: false }),
      );
      expect(request.mock.lastCall?.[1]).toEqual(
        fileMutation({ kind: GlyphFileMutationKind.CREATE, path: 'one/new.txt', text: '', byteOrderMark: false }),
      );
      await client.request({
        type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
        mutation: {
          operationId: 'text',
          path: 'file.txt',
          expectedContentRevision: 'revision',
          expectedToken: token,
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'text',
        },
      });
      expect(request.mock.lastCall?.[1]).toMatchObject({ mutation: { path: 'one/file.txt' } });
    });

    it('lists and canonicalizes editor paths through the workspace index and disk', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace', { 'file.txt': 'disk' });
      await fixture.create([root]);
      const client = captured.editorClients[0]!;
      const glob = vi
        .spyOn(RustWorkspacePathIndex.prototype, 'glob')
        .mockResolvedValue({ files: ['file.txt'], truncated: false });
      await expect(client.listPaths(10)).resolves.toEqual({ files: ['file.txt'], truncated: false });
      expect(glob).toHaveBeenLastCalledWith('**/*', { limit: 10 });
      await client.listPaths(5, '*.txt', 'src');
      expect(glob).toHaveBeenLastCalledWith('*.txt', { limit: 5, targetDirectory: 'src' });
      await expect(client.canonicalPath('file.txt')).resolves.toBe(
        await new FileSystemWorkspaceTextStore(root).canonicalPath('file.txt'),
      );
    });

    it.each([
      { names: ['workspace'], listed: ['file.txt', 'other/file.txt'], read: 'file.txt' },
      { names: ['one', 'two'], listed: ['one/file.txt', 'two/file.txt'], read: 'one/file.txt' },
    ])('reads live editor text for content search across $names', async ({ names, listed, read }) => {
      const fixture = await factoryFixture();
      const roots: string[] = [];
      for (const name of names) roots.push(await fixture.folder(name, { 'file.txt': 'disk' }));
      await fixture.create(roots);
      vi.spyOn(RustWorkspacePathIndex.prototype, 'filterPaths').mockImplementation(async paths =>
        paths.filter(path => path === 'file.txt'),
      );
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) =>
          request.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS
            ? { operationId: request.operationId, ok: true, workingCopyPaths: listed }
            : editorResponse(request, read, 'live'),
        );
      const signal = new AbortController().signal;
      await expect(captured.indexOptions[0]!.readContentOverrides!(signal)).resolves.toEqual({ 'file.txt': 'live' });
      expect(request).toHaveBeenLastCalledWith(
        factoryIdentity,
        expect.objectContaining({ type: GlyphEditorRequestType.READ_SNAPSHOT, path: read }),
        signal,
      );
    });

    it('publishes human-interaction events through the created runtime', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const event = {
        type: GlyphHostEventType.QUESTION,
        chatId: 'chat',
        runId: 'run',
        question: { id: 'question', title: 'Question', prompt: 'Why?' },
      } as const;
      captured.brokers[0]!.emit(event);
      expect(emit).toHaveBeenCalledExactlyOnceWith(event);
    });

    it.each([
      { mode: AgentModeID.PLAN, decision: GlyphApprovalDecision.ALLOW_ONCE, status: GlyphModeSwapStatus.APPROVED },
      { mode: undefined, decision: GlyphApprovalDecision.DENY, status: GlyphModeSwapStatus.DENIED },
    ])(
      'asks before switching a chat from $mode and records the $status outcome',
      async ({ mode, decision, status }) => {
        const fixture = await factoryFixture();
        const emit = vi.fn<(event: GlyphHostEvent) => void>();
        await fixture.create([await fixture.folder('workspace')], emit);
        const summary = chatSummary({ mode: AgentModeID.AGENT });
        const setMode = vi.spyOn(ChatSessionManager.prototype, 'setMode').mockResolvedValue(summary);
        const finish = vi.spyOn(ProviderDesktopRuntime.prototype, 'finishModeSwap');
        const { broker } = captured.brokers[0]!;
        const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
        const decided = broker.run({ chatId: 'chat', runId: 'run' }, () =>
          captured.modeSwitches[0]!(
            AgentModeID.AGENT,
            'Build the plan',
            { chat, ...(mode ? { mode } : {}) },
            new AbortController().signal,
          ),
        );
        const approval = emit.mock.calls
          .map(([event]) => event)
          .find(event => event.type === GlyphHostEventType.APPROVAL);
        if (approval?.type !== GlyphHostEventType.APPROVAL) throw new Error('The switch was not offered.');
        expect(approval.approval.modeSwap).toMatchObject({
          source: mode ?? AgentModeID.AGENT,
          target: AgentModeID.AGENT,
          description: 'Build the plan',
        });
        broker.answer({ chatId: 'chat', runId: 'run', id: approval.approval.id, kind: 'approval', value: decision });
        await expect(decided).resolves.toBe(decision === GlyphApprovalDecision.ALLOW_ONCE);
        expect(finish).toHaveBeenCalledExactlyOnceWith('chat', approval.approval.id, status);
        if (decision === GlyphApprovalDecision.ALLOW_ONCE) {
          expect(setMode).toHaveBeenCalledExactlyOnceWith('chat', AgentModeID.AGENT);
          expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
        } else expect(setMode).not.toHaveBeenCalled();
      },
    );

    it('saves plan updates, publishes the chat, and returns the latest plan', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const plan = (revision: number) => ({
        id: 'plan',
        revision,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
        agents: [],
      });
      const updated = chatSummary({ plans: [plan(1), plan(2)] });
      const updatePlan = vi
        .spyOn(ChatSessionManager.prototype, 'updatePlan')
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(chatSummary());
      const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
      const update = {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
      };
      const signal = new AbortController().signal;
      await expect(captured.plans[0]!(chat, update, signal)).resolves.toEqual(plan(2));
      expect(updatePlan).toHaveBeenCalledWith(chat, update, signal);
      expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: updated });
      await expect(captured.plans[0]!(chat, update)).resolves.toBeUndefined();
    });

    it('saves todo updates, publishes the chat, and returns the resulting list', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const todos = [{ id: 'todo', text: 'Do it', status: TodoStatus.PENDING }];
      const updated = chatSummary({ todos });
      vi.spyOn(ChatSessionManager.prototype, 'updateTodos')
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(chatSummary());
      const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
      await expect(captured.todos[0]!(chat, { items: todos, replace: true })).resolves.toEqual(todos);
      expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: updated });
      await expect(captured.todos[0]!(chat, { items: [], replace: true })).resolves.toEqual([]);
    });

    it('runs agent reviews only through an available account with inference access', async () => {
      const fixture = await factoryFixture();
      await fixture.create([await fixture.folder('workspace')]);
      const account = (provider: string, id: string) => ({
        provider,
        id,
        label: id,
        connected: true,
        inferenceAccess: true,
      });
      vi.spyOn(GlyphService.prototype, 'accounts', 'get').mockReturnValue([
        account('other', 'ready'),
        account('openai', 'blocked'),
        account('openai', 'ready'),
      ]);
      vi.spyOn(GlyphService.prototype, 'hasInferenceAccess').mockImplementation(value => value.id === 'ready');
      const provider = {} as ChatProvider;
      const createProvider = vi.spyOn(OpenAIBackend.prototype, 'createProvider').mockReturnValue(provider);
      const createConversation = captured.reviewExecutors[0]!;
      expect(() => createConversation({ accountProvider: 'openai', accountId: 'missing', model: 'gpt' })).toThrow(
        'The review account is unavailable.',
      );
      expect(() => createConversation({ accountProvider: 'openai', accountId: 'blocked', model: 'gpt' })).toThrow(
        'The review account is unavailable.',
      );
      const conversation = createConversation({ accountProvider: 'openai', accountId: 'ready', model: 'gpt' });
      expect(conversation).toBeInstanceOf(ChatConversation);
      expect(createProvider).toHaveBeenCalledExactlyOnceWith(account('openai', 'ready'), { slug: 'gpt', name: 'gpt' });
      const [conversationProvider, , redact, recordUsage] = captured.conversations.at(-1)!;
      expect(conversationProvider).toBe(provider);
      vi.spyOn(GlyphService.prototype, 'redact').mockReturnValue('[redacted]');
      expect(redact('secret')).toBe('[redacted]');
      expect(recordUsage({} as Parameters<typeof recordUsage>[0])).toBeUndefined();
    });

    it('stops shells when the application service fails to initialize', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      fixture.initialize.mockRejectedValueOnce(new Error('Index failed'));
      const shells = vi.spyOn(ShellSessionManager.prototype, 'dispose');
      await expect(fixture.create([root])).rejects.toThrow('Index failed');
      expect(shells).toHaveBeenCalledOnce();
    });

    it('releases every service when agent reviews fail to initialize', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      vi.spyOn(AgentReviewService.prototype, 'initialize').mockRejectedValueOnce(new Error('Review store failed'));
      const reviews = vi.spyOn(AgentReviewService.prototype, 'dispose');
      const shells = vi.spyOn(ShellSessionManager.prototype, 'dispose');
      const glyph = vi.spyOn(GlyphService.prototype, 'dispose');
      await expect(fixture.create([root])).rejects.toThrow('Review store failed');
      expect(reviews).toHaveBeenCalledOnce();
      expect(shells).toHaveBeenCalledOnce();
      expect(glyph).toHaveBeenCalledOnce();
    });

    it('sends provider traffic through an injected transport', async () => {
      const transport = vi.fn<typeof fetch>();
      const fixture = await factoryFixture({ transport });
      await fixture.create([await fixture.folder('workspace')]);
      const clients = captured.providerFactories.map(([, , , client]) => client);
      expect(clients).toHaveLength(2);
      expect(clients[0]).toBeInstanceOf(OpenAI);
      expect(clients[1]).toBe(clients[0]);
      expect(clients[0]?.baseURL).toBe(new EnvironmentConfigurationProvider().openAI.resource);
    });
  });

  it('leaves workspace-wide editor requests unqualified even when given a path', () => {
    const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter());
    const request: GlyphEditorRequest = { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'copies' };

    const qualified = (
      factory as unknown as {
        withRequestPath(request: GlyphEditorRequest, path: string | undefined): GlyphEditorRequest;
      }
    ).withRequestPath(request, '/workspace/file.txt');

    expect(qualified).toBe(request);
  });
});

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const factoryIdentity: GlyphConnectionIdentity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };

async function factoryFixture(options: { readonly transport?: typeof fetch } = {}) {
  for (const values of Object.values(captured)) values.length = 0;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-factory-')));
  vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
  vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
  const initialize = vi.spyOn(GlyphService.prototype, 'initialize').mockResolvedValue();
  const editors = new EditorRpcRouter();
  const factory = new OpenAIDesktopRuntimeFactory(editors, options.transport);
  const runtimes: ProviderDesktopRuntime[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await factory.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    editors,
    initialize,
    async folder(name: string, files: Readonly<Record<string, string>> = {}) {
      const path = join(directory, 'workspaces', name);
      await mkdir(path, { recursive: true });
      for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
      return path;
    },
    async create(paths: readonly string[], emit: (event: GlyphHostEvent) => void = () => {}) {
      const runtime = await factory.create({
        identity: factoryIdentity,
        roots: paths.map(path => ({ name: basename(path), canonicalPath: path, uri: `file://${path}` })),
        trusted: true,
        emit,
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function editorResponse(request: GlyphEditorRequest, path: string, text = 'text'): GlyphEditorResponse {
  return {
    operationId: 'mutation' in request ? request.mutation.operationId : request.operationId,
    ok: true,
    snapshot: {
      uri: `file:///${path}`,
      path,
      text,
      byteOrderMark: false,
      contentRevision: contentRevision(text, false),
      byteLength: Buffer.byteLength(text),
      mode: 0o644,
      identity: `file:///${path}`,
      dirty: false,
      token: { workspaceGeneration: 'g', resource: `file:///${path}`, incarnation: 'i', version: 1 },
    },
  };
}

type FileMutationInput = GlyphFileMutation extends infer Mutation
  ? Mutation extends unknown
    ? Omit<Mutation, 'operationId' | 'undoGroupId'>
    : never
  : never;

function fileMutation(
  mutation: FileMutationInput,
): Extract<GlyphEditorRequest, { type: GlyphEditorRequestType.APPLY_FILE_MUTATION }> {
  return {
    type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
    mutation: { ...mutation, operationId: 'file', undoGroupId: 'file' } as GlyphFileMutation,
  };
}

function chatSummary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    schemaVersion: 3,
    id: 'chat',
    title: 'Chat',
    titleOrigin: 'human',
    projectContextId: 'context',
    accountProvider: 'openai',
    accountId: 'account',
    modelSlug: 'gpt',
    modelName: 'GPT',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    turnCount: 0,
    ...overrides,
  };
}
